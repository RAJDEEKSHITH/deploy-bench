import { and, eq } from "drizzle-orm";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { env } from "../../config/env.js";
import { db } from "../../db/index.js";
import {
  jobAttempts,
  jobs,
  projects,
  runs,
} from "../../db/schema.js";
import { AppError } from "../../utils/app.error.js";
import { createFrontendBuildArtifact } from "../artifacs/artifacts.service.js";
import { buildAndPushContainerImage } from "../container-images/container-image.service.js";
import { getGithubAccessTokenForProject } from "../github/github-access-token.service.js";
import {
  withRepositoryAtCommit,
} from "../github/github-repository.service.js";
import {
  createJobContainer,
  executeCommands,
  removeJobContainer,
} from "./docker.service.js";
import { appendLogChunk } from "../logs/log-chunk.service.js";
import {
  closeLogStream,
  getOrCreateLogStream,
  type LogStreamType,
} from "../logs/log-stream.service.js";

type NormalizedJobDefinition = {
  commands: string[];
};

const LOG_STREAM_TYPES = ["stdout", "stderr", "system"] as const;
type ExecutionLogStreamType = (typeof LOG_STREAM_TYPES)[number];

type DeclaredArtifactOutput = { name: string; path: string };
type DeclaredContainerImageOutput = {
  name: string;
  registry: string;
  repository: string;
  contextPath: string;
  dockerfilePath: string;
  platform?: string;
};
type DeclaredJobOutputs = {
  artifacts: DeclaredArtifactOutput[];
  containerImage?: DeclaredContainerImageOutput;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isSafeRelativePath = (value: string, allowDot = false): boolean => {
  if (allowDot && value === ".") return true;
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes(":") ||
    isAbsolute(value)
  ) {
    return false;
  }
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
};

/** Runtime validation is intentional: jobs.definition is JSONB and old rows may not contain outputs. */
const getDeclaredJobOutputs = (definition: unknown): DeclaredJobOutputs => {
  if (!isRecord(definition)) {
    throw new AppError("Stored job definition is invalid", 500);
  }

  const rawArtifacts = definition.artifacts;
  const artifacts: DeclaredArtifactOutput[] = [];
  if (rawArtifacts !== undefined && !Array.isArray(rawArtifacts)) {
    throw new AppError("Stored job artifact declarations are invalid", 500);
  }

  const seenArtifactNames = new Set<string>();
  for (const value of Array.isArray(rawArtifacts) ? rawArtifacts : []) {
    if (!isRecord(value) || typeof value.name !== "string" || typeof value.path !== "string") {
      throw new AppError("Stored job artifact declaration is invalid", 500);
    }
    const name = value.name.trim();
    const path = value.path.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(name) || !isSafeRelativePath(path)) {
      throw new AppError("Stored job artifact declaration contains an unsafe name or path", 500);
    }
    if (seenArtifactNames.has(name)) {
      throw new AppError(`Stored job declares artifact name "${name}" more than once`, 500);
    }
    seenArtifactNames.add(name);
    artifacts.push({ name, path });
  }

  const rawImage = definition.containerImage;
  if (rawImage === undefined) return { artifacts };
  if (!isRecord(rawImage)) {
    throw new AppError("Stored job container image declaration is invalid", 500);
  }

  const { name, registry, repository, contextPath, dockerfilePath, platform } = rawImage;
  if (
    typeof name !== "string" || name.trim().length === 0 || name.length > 120 ||
    typeof registry !== "string" || registry.trim().length === 0 || registry.length > 255 ||
    typeof repository !== "string" || repository.trim().length < 2 || repository.length > 256 ||
    typeof contextPath !== "string" || !isSafeRelativePath(contextPath, true) ||
    typeof dockerfilePath !== "string" || !isSafeRelativePath(dockerfilePath) ||
    (platform !== undefined && typeof platform !== "string")
  ) {
    throw new AppError("Stored job container image declaration contains invalid or unsafe values", 500);
  }

  return {
    artifacts,
    containerImage: {
      name: name.trim(),
      registry: registry.trim().toLowerCase(),
      repository: repository.trim().toLowerCase(),
      contextPath,
      dockerfilePath,
      ...(platform === undefined ? {} : { platform }),
    },
  };
};

const resolveWorkspacePath = async (
  workspacePath: string,
  relativePath: string,
  allowRoot = false,
): Promise<string> => {
  if (!isSafeRelativePath(relativePath, allowRoot)) {
    throw new AppError(`Unsafe repository-relative path: ${relativePath}`, 400);
  }

  const workspaceRealPath = await realpath(workspacePath);
  const candidatePath = resolve(workspaceRealPath, relativePath);
  const relativeCandidate = relative(workspaceRealPath, candidatePath);
  if (
    (!allowRoot && relativeCandidate === "") ||
    relativeCandidate === ".." ||
    relativeCandidate.startsWith(`..${sep}`) ||
    isAbsolute(relativeCandidate)
  ) {
    throw new AppError("Declared output path is outside the checked-out repository", 400);
  }

  const candidateStats = await lstat(candidatePath).catch(() => null);
  if (!candidateStats) {
    throw new AppError(`Declared output path does not exist: ${relativePath}`, 400);
  }
  if (candidateStats.isSymbolicLink()) {
    throw new AppError(`Declared output path must not be a symbolic link: ${relativePath}`, 400);
  }

  const candidateRealPath = await realpath(candidatePath);
  const relativeRealPath = relative(workspaceRealPath, candidateRealPath);
  if (
    relativeRealPath === ".." ||
    relativeRealPath.startsWith(`..${sep}`) ||
    isAbsolute(relativeRealPath)
  ) {
    throw new AppError("Declared output resolves outside the checked-out repository", 400);
  }
  return candidateRealPath;
};

const assertSafeArtifactDirectory = async (directoryPath: string): Promise<void> => {
  const MAX_FILES = 25_000;
  const MAX_FILE_BYTES = 250 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
  let fileCount = 0;
  let totalBytes = 0;

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(directory, entry.name);
      const stats = await lstat(fullPath);
      if (stats.isSymbolicLink()) {
        throw new AppError(`Artifact directories cannot contain symbolic links: ${entry.name}`, 400);
      }
      if (stats.isDirectory()) {
        await walk(fullPath);
      } else if (stats.isFile()) {
        fileCount += 1;
        totalBytes += stats.size;
        if (stats.size > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES || fileCount > MAX_FILES) {
          throw new AppError("Artifact output exceeds file-count or size limits", 413);
        }
      } else {
        throw new AppError(`Artifact output contains an unsupported filesystem entry: ${entry.name}`, 400);
      }
    }
  };

  await walk(directoryPath);
  if (fileCount === 0) {
    throw new AppError("Declared artifact directory is empty", 400);
  }
};

const publishJobOutputs = async ({
  definition,
  workspacePath,
  runId,
  jobId,
  attemptId,
  timeoutSeconds,
  persistLog,
}: {
  definition: unknown;
  workspacePath: string;
  runId: string;
  jobId: string;
  attemptId: string;
  timeoutSeconds: number;
  persistLog: (stream: ExecutionLogStreamType, data: Buffer | string) => Promise<void>;
}): Promise<void> => {
  const outputs = getDeclaredJobOutputs(definition);

  for (const output of outputs.artifacts) {
    const outputDirectory = await resolveWorkspacePath(workspacePath, output.path);
    const stats = await lstat(outputDirectory);
    if (!stats.isDirectory()) {
      throw new AppError(`Artifact path must be a directory: ${output.path}`, 400);
    }
    await assertSafeArtifactDirectory(outputDirectory);

    const artifact = await createFrontendBuildArtifact({
      runId,
      distDirectory: outputDirectory,
      s3BucketName: env.S3_ARTIFACTS_BUCKET,
      producerJobId: jobId,
      producerJobAttemptId: attemptId,
      artifactName: output.name,
    });
    await persistLog("system", `Uploaded artifact "${output.name}" (${artifact.id}).\n`);
  }

  if (outputs.containerImage !== undefined) {
    const output = outputs.containerImage;
    const contextDirectory = await resolveWorkspacePath(workspacePath, output.contextPath, true);
    let imageLogWriteChain: Promise<void> = Promise.resolve();
    let imageLogFailure: unknown;

    const result = await buildAndPushContainerImage({
      runId,
      name: output.name,
      registry: output.registry,
      repository: output.repository,
      contextDirectory,
      dockerfilePath: output.dockerfilePath,
      timeoutMs: timeoutSeconds * 1_000,
      producer: { jobId, jobAttemptId: attemptId },
      ...(output.platform === undefined ? {} : { platform: output.platform }),
      onOutput: (stream, chunk) => {
        // Serialize durable appends so a noisy Docker build cannot create an unbounded
        // array of pending promises or reorder output chunks in persisted logs.
        imageLogWriteChain = imageLogWriteChain.then(() => persistLog(stream, chunk)).catch((error: unknown) => {
          imageLogFailure ??= error;
        });
      },
    });

    await imageLogWriteChain;
    if (imageLogFailure !== undefined) {
      throw new AppError("Container image logs could not be persisted", 502);
    }

    await persistLog(
      "system",
      `Published container image ${result.image.registry}/${result.image.repository}@${result.image.digest} (${result.image.id}).\n`,
    );
  }
};

const getCommands = (
  definition: unknown,
): string[] => {
  if (
    definition === null ||
    typeof definition !== "object" ||
    Array.isArray(definition)
  ) {
    throw new AppError(
      "Stored job definition is invalid",
      500,
    );
  }

  const commands = (
    definition as {
      commands?: unknown;
    }
  ).commands;

  if (
    !Array.isArray(commands) ||
    commands.length === 0 ||
    commands.some(
      (command) => typeof command !== "string",
    )
  ) {
    throw new AppError(
      "Stored job commands are invalid",
      500,
    );
  }

  return commands;
};

const failureMessage = (
  stdout: string,
  stderr: string,
  fallback: string,
): string => {
  const message =
    stderr.trim() ||
    stdout.trim() ||
    fallback;

  return message.slice(0, 2_000);
};

type AttemptOutcome = {
  status: "success" | "failed" | "timed_out";
  failureClass:
    | "configuration"
    | "user_code"
    | "dependency"
    | "infrastructure"
    | "timeout"
    | "authorization"
    | "cancelled"
    | "unknown"
    | null;
  retryable: boolean;
  exitCode: number | null;
  errorMessage: string | null;
};

const finishAttempt = async (
  attemptId: string,
  jobId: string,
  attemptNumber: number,
  maxAttempts: number,
  outcome: AttemptOutcome,
): Promise<void> => {
  const now = new Date();

  await db.transaction(async (tx) => {
    const [attempt] = await tx
      .update(jobAttempts)
      .set({
        status: outcome.status,
        failureClass: outcome.failureClass,
        retryable: outcome.retryable,
        exitCode: outcome.exitCode,
        errorMessage: outcome.errorMessage,
        finishedAt: now,
        heartbeatAt: now,
      })
      .where(
        and(
          eq(jobAttempts.id, attemptId),
          eq(jobAttempts.jobId, jobId),
        ),
      )
      .returning({
        id: jobAttempts.id,
      });

    if (!attempt) {
      throw new AppError(
        "Job attempt could not be finalized",
        500,
      );
    }

    if (outcome.status === "success") {
      await tx
        .update(jobs)
        .set({
          status: "success",
          nextAttemptAt: null,
          errorCode: null,
          errorMessage: null,
          finishedAt: now,
        })
        .where(
          and(
            eq(jobs.id, jobId),
            eq(jobs.status, "running"),
          ),
        );

      return;
    }

    /*
     * Timeout and infrastructure failures are retryable.
     * User-code failures are not automatically retried here.
     */
    const canRetry =
      outcome.retryable &&
      attemptNumber < maxAttempts;

    if (canRetry) {
      await tx
        .update(jobs)
        .set({
          status: "queued",
          nextAttemptAt: now,
          errorCode: null,
          errorMessage: null,
          finishedAt: null,
        })
        .where(
          and(
            eq(jobs.id, jobId),
            eq(jobs.status, "running"),
          ),
        );

      return;
    }

    await tx
      .update(jobs)
      .set({
        status: "failed",
        nextAttemptAt: null,
        errorMessage: outcome.errorMessage,
        finishedAt: now,
      })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, "running"),
        ),
      );
  });
};

export type ExecuteJobAttemptInput = {
  attemptId: string;
  queueJobId: string;
};

export type ExecuteJobAttemptResult =
  | {
      status: "success";
      attemptId: string;
    }
  | {
      status: "failed";
      attemptId: string;
      retryable: boolean;
      reason: string;
    }
  | {
      status: "timed_out";
      attemptId: string;
      retryable: boolean;
    }
  | {
      status: "ignored";
      attemptId: string;
      reason: string;
    };

export const executeJobAttempt = async ({
  attemptId,
  queueJobId,
}: ExecuteJobAttemptInput): Promise<ExecuteJobAttemptResult> => {
  const [context] = await db
    .select({
      attemptId: jobAttempts.id,
      attemptStatus: jobAttempts.status,
      attemptNumber: jobAttempts.attemptNumber,

      jobId: jobs.id,
      jobStatus: jobs.status,
      jobDefinition: jobs.definition,
      timeoutSeconds: jobs.timeoutSeconds,
      maxAttempts: jobs.maxAttempts,

      runId: runs.id,
      projectId: runs.projectId,
      commitSha: runs.commitSha,

      repositoryUrl: projects.repositoryUrl,
    })
    .from(jobAttempts)
    .innerJoin(
      jobs,
      eq(jobAttempts.jobId, jobs.id),
    )
    .innerJoin(
      runs,
      eq(jobs.runId, runs.id),
    )
    .innerJoin(
      projects,
      eq(runs.projectId, projects.id),
    )
    .where(eq(jobAttempts.id, attemptId))
    .limit(1);

  if (!context) {
    throw new AppError(
      "Job attempt not found",
      404,
    );
  }

  /*
   * BullMQ/job redelivery must never execute the same attempt twice.
   */
  if (context.attemptStatus !== "queued") {
    return {
      status: "ignored",
      attemptId,
      reason: `Attempt is already ${context.attemptStatus}`,
    };
  }

  if (context.jobStatus !== "queued" && context.jobStatus !== "running") {
    return {
      status: "ignored",
      attemptId,
      reason: `Job is ${context.jobStatus}`,
    };
  }

  const commands = getCommands(
    context.jobDefinition,
  );

  /*
   * Reserve this physical attempt.
   */
  const startedAt = new Date();

  const [startedAttempt] = await db
    .update(jobAttempts)
    .set({
      status: "running",
      queueJobId,
      startedAt,
      heartbeatAt: startedAt,
    })
    .where(
      and(
        eq(jobAttempts.id, attemptId),
        eq(jobAttempts.status, "queued"),
      ),
    )
    .returning({
      id: jobAttempts.id,
    });

  if (!startedAttempt) {
    return {
      status: "ignored",
      attemptId,
      reason: "Attempt was claimed by another worker",
    };
  }

  let containerId: string | undefined;
  const logStreamIds: Partial<Record<LogStreamType, string>> = {};
  let logTerminalStatus: "completed" | "failed" = "failed";

  const persistLog = async (
    streamType: ExecutionLogStreamType,
    data: Buffer | string,
  ): Promise<void> => {
    const streamId = logStreamIds[streamType];
    if (!streamId) {
      throw new AppError(`Log stream ${streamType} has not been initialized`, 500);
    }

    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    if (buffer.length === 0) return;

    const timestamp = new Date();
    await appendLogChunk({
      streamId,
      data: buffer,
      firstTimestamp: timestamp,
      lastTimestamp: timestamp,
    });
  };

  try {
    for (const streamType of LOG_STREAM_TYPES) {
      const stream = await getOrCreateLogStream({
        jobAttemptId: attemptId,
        streamType,
        s3Bucket: env.S3_LOGS_BUCKET,
      });
      logStreamIds[streamType] = stream.id;
    }

    await persistLog(
      "system",
      `Attempt #${context.attemptNumber} started. Preparing commit ${context.commitSha}.\n`,
    );

    await withRepositoryAtCommit(
      {
        repositoryUrl: context.repositoryUrl,
        commitSha: context.commitSha,
        accessToken: await getGithubAccessTokenForProject(context.projectId),
        checkout: true,
      },
      async (workspace) => {
        await persistLog(
          "system",
          `Repository checkout is ready at ${context.commitSha}.\n`,
        );

        const container = await createJobContainer(
          workspace.path,
        );

        containerId = container.id;

        await persistLog(
          "system",
          `Created Docker container. Executing ${commands.length} command(s).\n`,
        );

        await db
          .update(jobAttempts)
          .set({
            containerId,
            heartbeatAt: new Date(),
          })
          .where(eq(jobAttempts.id, attemptId));

        const result = await executeCommands(
          containerId,
          commands,
          context.timeoutSeconds,
          {
            onStdout: (chunk) => persistLog("stdout", chunk),
            onStderr: (chunk) => persistLog("stderr", chunk),
          },
        );

        if (result.timedOut) {
          await persistLog("system", "Job command execution timed out.\n");
          const message = failureMessage(
            result.stdout,
            result.stderr,
            "Job execution timed out",
          );

          await finishAttempt(
            attemptId,
            context.jobId,
            context.attemptNumber,
            context.maxAttempts,
            {
              status: "timed_out",
              failureClass: "timeout",
              retryable: true,
              exitCode: null,
              errorMessage: message,
            },
          );

          return;
        }

        if (!result.success) {
          await persistLog(
            "system",
            `Job command failed with exit code ${result.exitCode ?? "unknown"}.\n`,
          );
          const message = failureMessage(
            result.stdout,
            result.stderr,
            `Command exited with code ${result.exitCode ?? "unknown"}`,
          );

          await finishAttempt(
            attemptId,
            context.jobId,
            context.attemptNumber,
            context.maxAttempts,
            {
              status: "failed",
              failureClass: "user_code",
              retryable: false,
              exitCode: result.exitCode,
              errorMessage: message,
            },
          );

          return;
        }

        await publishJobOutputs({
          definition: context.jobDefinition,
          workspacePath: workspace.path,
          runId: context.runId,
          jobId: context.jobId,
          attemptId,
          timeoutSeconds: context.timeoutSeconds,
          persistLog,
        });

        await persistLog("system", "All commands and declared outputs completed successfully.\n");
        await finishAttempt(
          attemptId,
          context.jobId,
          context.attemptNumber,
          context.maxAttempts,
          {
            status: "success",
            failureClass: null,
            retryable: false,
            exitCode: 0,
            errorMessage: null,
          },
        );
      },
    );

    const [finalAttempt] = await db
      .select({
        status: jobAttempts.status,
        retryable: jobAttempts.retryable,
      })
      .from(jobAttempts)
      .where(eq(jobAttempts.id, attemptId))
      .limit(1);

    if (!finalAttempt) {
      throw new AppError(
        "Final job attempt state could not be resolved",
        500,
      );
    }

    if (finalAttempt.status === "success") {
      logTerminalStatus = "completed";
      return {
        status: "success",
        attemptId,
      };
    }

    if (finalAttempt.status === "timed_out") {
      return {
        status: "timed_out",
        attemptId,
        retryable: finalAttempt.retryable === true,
      };
    }

    return {
      status: "failed",
      attemptId,
      retryable: finalAttempt.retryable === true,
      reason: "Job command failed",
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.slice(0, 2_000)
        : "Job execution failed";

    try {
      await persistLog("system", `Execution infrastructure error: ${message}\n`);
    } catch (logError: unknown) {
      console.error("Failed to persist execution error to job logs", logError);
    }

    /*
     * Docker/repository failures are infrastructure failures and can
     * be retried according to jobs.maxAttempts.
     */
    const appErrorStatus = error instanceof AppError ? error.statusCode : null;
    const wasCancelled = appErrorStatus === 499;
    const isConfigurationFailure =
      appErrorStatus !== null &&
      appErrorStatus >= 400 &&
      appErrorStatus < 500 &&
      appErrorStatus !== 408 &&
      appErrorStatus !== 429 &&
      !wasCancelled;
    const canRetry =
      !wasCancelled &&
      !isConfigurationFailure &&
      context.attemptNumber < context.maxAttempts;

    await finishAttempt(
      attemptId,
      context.jobId,
      context.attemptNumber,
      context.maxAttempts,
      {
        status: "failed",
        failureClass: wasCancelled
          ? "cancelled"
          : isConfigurationFailure
            ? "configuration"
            : "infrastructure",
        retryable: canRetry,
        exitCode: null,
        errorMessage: message,
      },
    );

    return {
      status: "failed",
      attemptId,
      retryable: canRetry,
      reason: message,
    };
  } finally {
    const closeResults = await Promise.allSettled(
      Object.values(logStreamIds)
        .filter((streamId): streamId is string => typeof streamId === "string")
        .map((streamId) =>
          closeLogStream({
            streamId,
            status: logTerminalStatus,
          }),
        ),
    );

    for (const result of closeResults) {
      if (result.status === "rejected") {
        console.error("Failed to close a job log stream", result.reason);
      }
    }

    if (containerId) {
      try {
        await removeJobContainer(containerId);
      } catch (cleanupError: unknown) {
        console.error("Failed to remove job container after attempt", {
          attemptId,
          containerId,
          cleanupError,
        });
      }
    }
  }
};


