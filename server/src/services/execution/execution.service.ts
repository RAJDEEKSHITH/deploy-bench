import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  jobAttempts,
  jobs,
  projects,
  runs,
} from "../../db/schema.js";
import { AppError } from "../../utils/app.error.js";
import {
  withRepositoryAtCommit,
} from "../github/github-repository.service.js";
import {
  createJobContainer,
  executeCommands,
  removeJobContainer,
} from "./docker.service.js";

type NormalizedJobDefinition = {
  commands: string[];
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
    | "canceled"
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

  if (context.jobStatus !== "queued") {
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

  try {
    await withRepositoryAtCommit(
      {
        repositoryUrl: context.repositoryUrl,
        commitSha: context.commitSha,
        checkout: true,
      },
      async (workspace) => {
        const container = await createJobContainer(
          workspace.path,
        );

        containerId = container.id;

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
        );

        if (result.timedOut) {
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

    /*
     * Docker/repository failures are infrastructure failures and can
     * be retried according to jobs.maxAttempts.
     */
    await finishAttempt(
      attemptId,
      context.jobId,
      context.attemptNumber,
      context.maxAttempts,
      {
        status: "failed",
        failureClass: "infrastructure",
        retryable: true,
        exitCode: null,
        errorMessage: message,
      },
    );

    return {
      status: "failed",
      attemptId,
      retryable:
        context.attemptNumber < context.maxAttempts,
      reason: message,
    };
  } finally {
    if (containerId) {
      await removeJobContainer(containerId);
    }
  }
};