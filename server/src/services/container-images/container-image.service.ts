import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  DescribeImagesCommand,
  DescribeRepositoriesCommand,
  ECRClient,
  GetAuthorizationTokenCommand,
  type AuthorizationData,
  type Repository,
} from "@aws-sdk/client-ecr";
import { and, eq } from "drizzle-orm";

import { db } from "../../db/index.js";
import { containerImages, jobAttempts, jobs, runs } from "../../db/schema.js";
import { AppError } from "../../utils/app.error.js";
import { resolveProjectEcrCredentials } from "../deployments/deployment-credentials.service.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

type ContainerImage = typeof containerImages.$inferSelect;

type DockerOutputStream = "stdout" | "stderr";

export type ContainerImageOutputHandler = (stream: DockerOutputStream, chunk: Buffer) => void;

export type ContainerImageProducer = {
  jobId: string;
  jobAttemptId: string;
};

export type ContainerImageIdentityInput = {
  runId: string;
  name: string;
  registry: string;
  repository: string;
  producer?: ContainerImageProducer | undefined;
};

export type BuildAndPushContainerImageInput = ContainerImageIdentityInput & {
  contextDirectory: string;
  dockerfilePath?: string | undefined;
  platform?: string | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  onOutput?: ContainerImageOutputHandler | undefined;
};

export type BuildAndPushContainerImageResult = {
  action: "created" | "recovered";
  image: ContainerImage;
};

export type RecoverContainerImageInput = ContainerImageIdentityInput;

export type RecoverContainerImageResult =
  | { recovered: true; image: ContainerImage }
  | { recovered: false; image: null };

type ImageIdentity = {
  runId: string;
  name: string;
  registry: string;
  registryId: string;
  region: string;
  repository: string;
  tag: string;
  producer: ContainerImageProducer | null;
};

type BuildOptions = {
  contextDirectory: string;
  dockerfilePath: string;
  platform: string | undefined;
  timeoutMs: number;
};

type DockerContext = {
  timeoutMs: number;
  dockerConfigDir: string;
  signal?: AbortSignal | undefined;
  onOutput?: ContainerImageOutputHandler | undefined;
};

type DockerCommandOptions = DockerContext & {
  input?: string | undefined;
};

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const DEFAULT_DOCKER_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_DOCKER_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

const MAX_ERROR_TAIL_BYTES = 32 * 1024;
const MAX_ERROR_DETAIL_CHARS = 2_000;

const DIGEST_LOOKUP_ATTEMPTS = 10;
const DIGEST_LOOKUP_DELAY_MS = 1_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ECR_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/i;
const ECR_REGISTRY_PATTERN = /^([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/i;
const ECR_REPOSITORY_PATTERN = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const PLATFORM_PATTERN = /^[a-z0-9]+\/[a-z0-9]+(?:\/[a-z0-9]+)?$/i;

/* -------------------------------------------------------------------------- */
/* Utility functions                                                          */
/* -------------------------------------------------------------------------- */

const sleep = (milliseconds: number): Promise<void> =>
  new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });

const requireNonEmptyString = (value: string, field: string, maxLength: number): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new AppError(`Invalid ${field}`, 400);
  }
  return normalized;
};

const requireUuid = (value: string, field: string): string => {
  if (!UUID_PATTERN.test(value)) {
    throw new AppError(`Invalid ${field}`, 400);
  }
  return value.toLowerCase();
};

const getPgCode = (error: unknown): string | undefined => {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  if (typeof error === "object" && error !== null && "cause" in error) {
    const cause = error.cause;
    if (typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string") {
      return cause.code;
    }
  }
  return undefined;
};

const awsErrorName = (error: unknown): string => (error instanceof Error ? error.name : "UnknownError");
const isAppError = (error: unknown): error is AppError => error instanceof AppError;
const isCanceledOrSuperseded = (status: typeof runs.$inferSelect.status): boolean =>
  status === "cancelled" || status === "superseded";

/* -------------------------------------------------------------------------- */
/* Stage 31: deterministic image references                                   */
/* -------------------------------------------------------------------------- */

export const getContainerImageTag = (runId: string): string => `run-${requireUuid(runId, "run ID")}`;

export const getContainerImageUri = ({ registry, repository, tag }: { registry: string; repository: string; tag: string }): string =>
  `${registry}/${repository}:${tag}`;

export const getContainerImageDigestReference = ({ registry, repository, digest }: { registry: string; repository: string; digest: string }): string => {
  if (!ECR_DIGEST_PATTERN.test(digest)) {
    throw new AppError("Invalid ECR image digest", 500);
  }
  return `${registry}/${repository}@${digest.toLowerCase()}`;
};

/* -------------------------------------------------------------------------- */
/* Identity normalization                                                     */
/* -------------------------------------------------------------------------- */

const normalizeIdentity = (input: ContainerImageIdentityInput): ImageIdentity => {
  const runId = requireUuid(input.runId, "run ID");
  const name = requireNonEmptyString(input.name, "container image name", 120);
  const registry = requireNonEmptyString(input.registry, "ECR registry", 255).toLowerCase();
  const repository = requireNonEmptyString(input.repository, "ECR repository", 256).toLowerCase();

  const registryMatch = ECR_REGISTRY_PATTERN.exec(registry);
  const registryId = registryMatch?.[1];
  const registryRegion = registryMatch?.[2]?.toLowerCase();

  if (registryId === undefined || registryRegion === undefined) {
    throw new AppError("Invalid ECR registry", 400);
  }

  if (repository.length < 2 || !ECR_REPOSITORY_PATTERN.test(repository)) {
    throw new AppError("Invalid ECR repository name", 400);
  }

  const producer = input.producer === undefined ? null : {
    jobId: requireUuid(input.producer.jobId, "producer job ID"),
    jobAttemptId: requireUuid(input.producer.jobAttemptId, "producer job attempt ID"),
  };

  return { runId, name, registry, registryId, region: registryRegion, repository, tag: getContainerImageTag(runId), producer };
};

/* -------------------------------------------------------------------------- */
/* Docker build input                                                         */
/* -------------------------------------------------------------------------- */

const normalizeBuildOptions = async (input: BuildAndPushContainerImageInput): Promise<BuildOptions> => {
  const timeoutMs = input.timeoutMs ?? DEFAULT_DOCKER_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_DOCKER_TIMEOUT_MS) {
    throw new AppError("Invalid Docker command timeout", 400);
  }

  const platform = input.platform?.trim() || undefined;
  if (platform !== undefined && !PLATFORM_PATTERN.test(platform)) {
    throw new AppError("Invalid Docker build platform", 400);
  }

  const contextDirectory = await realpath(resolve(input.contextDirectory)).catch(() => null);
  if (contextDirectory === null) throw new AppError("Docker build context directory was not found", 400);

  const contextStats = await stat(contextDirectory).catch(() => null);
  if (contextStats === null || !contextStats.isDirectory()) {
    throw new AppError("Docker build context directory was not found", 400);
  }

  const requestedDockerfile = input.dockerfilePath?.trim() || "Dockerfile";
  const dockerfilePath = await realpath(resolve(contextDirectory, requestedDockerfile)).catch(() => null);
  if (dockerfilePath === null) throw new AppError("Dockerfile was not found", 400);

  const dockerfileStats = await stat(dockerfilePath).catch(() => null);
  if (dockerfileStats === null || !dockerfileStats.isFile()) {
    throw new AppError("Dockerfile was not found", 400);
  }

  const relativeDockerfile = relative(contextDirectory, dockerfilePath);
  if (relativeDockerfile === "" || relativeDockerfile === ".." || relativeDockerfile.startsWith(`..${sep}`) || isAbsolute(relativeDockerfile)) {
    throw new AppError("Dockerfile must be inside the build context", 400);
  }

  return { contextDirectory, dockerfilePath, platform, timeoutMs };
};

/* -------------------------------------------------------------------------- */
/* Database                                                                   */
/* -------------------------------------------------------------------------- */

const loadRun = async (runId: string): Promise<{ id: string; projectId: string; status: typeof runs.$inferSelect.status }> => {
  const [run] = await db.select({ id: runs.id, projectId: runs.projectId, status: runs.status }).from(runs).where(eq(runs.id, runId)).limit(1);
  if (run === undefined) throw new AppError("Run not found", 404);
  return run;
};

const assertProducerBelongsToRun = async (identity: ImageIdentity): Promise<void> => {
  if (identity.producer === null) return;
  const [row] = await db.select({ attemptId: jobAttempts.id })
    .from(jobAttempts)
    .innerJoin(jobs, eq(jobAttempts.jobId, jobs.id))
    .where(and(
      eq(jobAttempts.id, identity.producer.jobAttemptId),
      eq(jobs.id, identity.producer.jobId),
      eq(jobs.runId, identity.runId)
    )).limit(1);

  if (row === undefined) throw new AppError("Producer job attempt does not belong to this run and job", 409);
};

const findPersistedContainerImage = async (identity: ImageIdentity): Promise<ContainerImage | null> => {
  const [row] = await db.select().from(containerImages)
    .where(and(
      eq(containerImages.registry, identity.registry),
      eq(containerImages.repository, identity.repository),
      eq(containerImages.tag, identity.tag)
    )).limit(1);
  return row ?? null;
};

const persistContainerImage = async (identity: ImageIdentity, digest: string): Promise<ContainerImage> => {
  if (!ECR_DIGEST_PATTERN.test(digest)) throw new AppError("Invalid ECR image digest", 500);
  const normalizedDigest = digest.toLowerCase();

  const existing = await findPersistedContainerImage(identity);
  if (existing !== null) {
    if (existing.runId !== identity.runId) throw new AppError("ECR image tag is already associated with a different run", 409);
    if (existing.name !== identity.name) throw new AppError("Existing container image has a different name", 409);
    if (existing.digest !== normalizedDigest) throw new AppError("ECR image digest differs from the persisted container image", 409);
    return existing;
  }

  try {
    const [inserted] = await db.insert(containerImages)
      .values({
        name: identity.name,
        runId: identity.runId,
        tag: identity.tag,
        digest: normalizedDigest,
        producerJobId: identity.producer?.jobId ?? null,
        producerJobAttemptId: identity.producer?.jobAttemptId ?? null,
        registry: identity.registry,
        repository: identity.repository,
      })
      .onConflictDoNothing({ target: [containerImages.registry, containerImages.repository, containerImages.tag] })
      .returning();
    if (inserted !== undefined) return inserted;
  } catch (error: unknown) {
    if (getPgCode(error) === "23503") throw new AppError("Run or producer job attempt no longer exists", 409);
    throw error;
  }

  const row = await findPersistedContainerImage(identity);
  if (row === null) throw new AppError("Failed to persist container image metadata", 500);
  if (row.runId !== identity.runId) throw new AppError("ECR image tag is already associated with a different run", 409);
  if (row.name !== identity.name) throw new AppError("Existing container image has a different name", 409);
  if (row.digest !== normalizedDigest) throw new AppError("ECR image digest differs from the persisted container image", 409);

  return row;
};

/* -------------------------------------------------------------------------- */
/* ECR                                                                        */
/* -------------------------------------------------------------------------- */

const assertRepositoryUsesImmutableTags = async (identity: ImageIdentity, ecrClient: ECRClient): Promise<void> => {
  try {
    const response = await ecrClient.send(new DescribeRepositoriesCommand({
      registryId: identity.registryId,
      repositoryNames: [identity.repository],
    }));
    
    if (response.repositories?.[0]?.imageTagMutability !== "IMMUTABLE") {
      throw new AppError("ECR repository must use immutable image tags", 500);
    }
  } catch (error: unknown) {
    if (awsErrorName(error) === "RepositoryNotFoundException") throw new AppError("ECR repository was not found", 500);
    throw new AppError(`Failed to inspect ECR repository (${awsErrorName(error)})`, 500);
  }
};

const findDigestByTag = async (identity: ImageIdentity, ecrClient: ECRClient): Promise<string | null> => {
  try {
    const response = await ecrClient.send(new DescribeImagesCommand({
      registryId: identity.registryId,
      repositoryName: identity.repository,
      imageIds: [{ imageTag: identity.tag }],
    }));

    const digest = response.imageDetails?.[0]?.imageDigest;
    if (digest === undefined) return null;
    if (!ECR_DIGEST_PATTERN.test(digest)) throw new AppError("ECR returned an invalid image digest", 500);
    return digest.toLowerCase();
  } catch (error: unknown) {
    if (isAppError(error)) throw error;
    const name = awsErrorName(error);
    if (name === "ImageNotFoundException") return null;
    if (name === "RepositoryNotFoundException") throw new AppError("ECR repository was not found", 500);
    throw new AppError(`Failed to resolve ECR image digest (${name})`, 500);
  }
};

const waitForDigest = async (identity: ImageIdentity, ecrClient: ECRClient, signal?: AbortSignal): Promise<string> => {
  for (let attempt = 1; attempt <= DIGEST_LOOKUP_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw new AppError("Container image build was canceled", 409);

    const digest = await findDigestByTag(identity, ecrClient);
    if (digest !== null) return digest;

    if (attempt < DIGEST_LOOKUP_ATTEMPTS) await sleep(DIGEST_LOOKUP_DELAY_MS);
  }
  throw new AppError("Image was pushed to ECR but its digest could not be resolved", 500);
};

/* -------------------------------------------------------------------------- */
/* Docker                                                                     */
/* -------------------------------------------------------------------------- */

const notifyOutput = (handler: ContainerImageOutputHandler | undefined, stream: DockerOutputStream, chunk: Buffer): void => {
  if (handler === undefined) return;
  try { handler(stream, chunk); } catch { /* Ignore */ }
};

const runDocker = (args: readonly string[], options: DockerCommandOptions): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (options.signal?.aborted) return reject(new AppError("Docker command was canceled", 409));

    const child = spawn("docker", [...args], {
      env: { ...process.env, DOCKER_CONFIG: options.dockerConfigDir },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      signal: options.signal,
      timeout: options.timeoutMs,
      killSignal: "SIGKILL"
    });

    const stderrChunks: Buffer[] = [];

    const handleData = (stream: DockerOutputStream) => (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stream === "stderr") stderrChunks.push(buffer);
      notifyOutput(options.onOutput, stream, buffer);
    };

    child.stdout.on("data", handleData("stdout"));
    child.stderr.on("data", handleData("stderr"));
    child.stdin.on("error", () => undefined); // Ignore EPIPE
    child.stdin.end(options.input);

    child.once("error", (error: Error) => {
      if (error.name === "AbortError") return reject(new AppError("Docker command was canceled", 409));
      reject(new AppError(`Failed to run Docker: ${error.message}`, 500));
    });

    child.once("close", (code, signal) => {
      if (code === 0) return resolve();

      let reason = "unknown termination";
      if (options.signal?.aborted) reason = "canceled";
      else if (signal) reason = `signal ${signal} (possible timeout)`;
      else if (code !== null) reason = `exit ${code}`;

      const detail = Buffer.concat(stderrChunks)
        .subarray(-MAX_ERROR_TAIL_BYTES)
        .toString("utf8")
        .trim()
        .slice(-MAX_ERROR_DETAIL_CHARS);

      reject(new AppError(`Docker ${args[0] ?? "command"} failed (${reason})${detail.length > 0 ? `: ${detail}` : ""}`, 500));
    });
  });

const withDockerConfigDir = async <T>(operation: (dockerConfigDir: string) => Promise<T>): Promise<T> => {
  const dockerConfigDir = await mkdtemp(join(tmpdir(), "deploybench-docker-"));
  try {
    return await operation(dockerConfigDir);
  } finally {
    await rm(dockerConfigDir, { recursive: true, force: true });
  }
};

const loginDockerToEcr = async (identity: ImageIdentity, ecrClient: ECRClient, docker: DockerContext): Promise<void> => {
  try {
    const response = await ecrClient.send(new GetAuthorizationTokenCommand({ registryIds: [identity.registryId] }));
    const authorization = response.authorizationData?.[0];
    const token = authorization?.authorizationToken;
    const endpoint = authorization?.proxyEndpoint?.trim().replace(/^https?:\/\//i, "").replace(/\/+$/g, "").toLowerCase();

    if (!token || !endpoint || endpoint !== identity.registry) {
      throw new AppError("ECR authorization response is invalid", 500);
    }

    const [username, ...passwordParts] = Buffer.from(token, "base64").toString("utf8").split(":");
    const password = passwordParts.join(":");

    if (username !== "AWS" || !password) throw new AppError("Invalid ECR authorization credentials", 500);

    await runDocker(["login", identity.registry, "--username", "AWS", "--password-stdin"], {
      ...docker,
      input: password,
    });
  } catch (error: unknown) {
    if (isAppError(error)) throw error;
    throw new AppError(`Failed to obtain ECR authorization token (${awsErrorName(error)})`, 500);
  }
};

/* -------------------------------------------------------------------------- */
/* Main Exports                                                               */
/* -------------------------------------------------------------------------- */

export const buildAndPushContainerImage = async (input: BuildAndPushContainerImageInput): Promise<BuildAndPushContainerImageResult> => {
  const identity = normalizeIdentity(input);
  const { contextDirectory, dockerfilePath, platform, timeoutMs } = await normalizeBuildOptions(input);
  const run = await loadRun(identity.runId);
  const credentials = await resolveProjectEcrCredentials(run.projectId);
  const ecrClient = new ECRClient({ region: identity.region, credentials });

  try {
    await assertProducerBelongsToRun(identity);
    await assertRepositoryUsesImmutableTags(identity, ecrClient);

    const existingEcrDigest = await findDigestByTag(identity, ecrClient);
    const existingDbImage = await findPersistedContainerImage(identity);

    if (existingDbImage !== null) {
      if (existingEcrDigest === null) throw new AppError("Persisted container image is missing from ECR", 409);
      if (existingDbImage.digest !== existingEcrDigest) throw new AppError("ECR image digest differs from the persisted container image", 409);
      return { action: "recovered", image: existingDbImage };
    }

    if (existingEcrDigest !== null) {
      return { action: "recovered", image: await persistContainerImage(identity, existingEcrDigest) };
    }

    if (isCanceledOrSuperseded(run.status)) throw new AppError("Run is no longer active", 409);
    if (input.signal?.aborted) throw new AppError("Container image build was canceled", 409);

    const imageUri = getContainerImageUri(identity);

    return await withDockerConfigDir(async (dockerConfigDir): Promise<BuildAndPushContainerImageResult> => {
      const docker: DockerContext = { timeoutMs, dockerConfigDir, signal: input.signal, onOutput: input.onOutput };

      await loginDockerToEcr(identity, ecrClient, docker);

      await runDocker([
        "build", "--tag", imageUri, "--file", dockerfilePath,
        ...(platform === undefined ? [] : ["--platform", platform]),
        contextDirectory,
      ], docker);

      try {
        await runDocker(["push", imageUri], docker);
      } catch (pushError: unknown) {
        if (input.signal?.aborted) throw pushError;
        const recoveredDigest = await findDigestByTag(identity, ecrClient).catch(() => null);
        if (recoveredDigest === null) throw pushError;
        return { action: "recovered", image: await persistContainerImage(identity, recoveredDigest) };
      }

      const digest = await waitForDigest(identity, ecrClient, input.signal);
      return { action: "created", image: await persistContainerImage(identity, digest) };
    });
  } finally {
    ecrClient.destroy();
  }
};

export const recoverContainerImage = async (input: RecoverContainerImageInput): Promise<RecoverContainerImageResult> => {
  const identity = normalizeIdentity(input);
  const run = await loadRun(identity.runId);
  const credentials = await resolveProjectEcrCredentials(run.projectId);
  const ecrClient = new ECRClient({ region: identity.region, credentials });
  try {
    await assertProducerBelongsToRun(identity);
    await assertRepositoryUsesImmutableTags(identity, ecrClient);

    const digest = await findDigestByTag(identity, ecrClient);
    if (digest === null) return { recovered: false, image: null };
    return { recovered: true, image: await persistContainerImage(identity, digest) };
  } finally {
    ecrClient.destroy();
  }
};
