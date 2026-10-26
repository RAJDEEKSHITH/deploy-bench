import { execFile, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DOCKER_COMMAND_TIMEOUT_MS = 30_000;
const DOCKER_IMAGE_PULL_TIMEOUT_MS = 10 * 60_000;

const MAX_DOCKER_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_CAPTURED_LOG_BYTES = 10 * 1024 * 1024;
const MAX_ERROR_MESSAGE_LENGTH = 2_000;

export const DEFAULT_JOB_IMAGE =
  process.env.DEPLOYBENCH_JOB_IMAGE ?? "node:24-bookworm";

type DockerCommandError = Error & {
  code?: string | number;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stdout?: unknown;
  stderr?: unknown;
};

const toOutputString = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }

  return "";
};

/**
 * Keep the end of the error output because Docker often prints progress
 * before reporting the actual failure.
 */
const sanitizeError = (
  error: unknown,
  timeoutMs: number,
): string => {
  if (!(error instanceof Error)) {
    return String(error).slice(-MAX_ERROR_MESSAGE_LENGTH);
  }

  const commandError = error as DockerCommandError;

  const stdout = toOutputString(commandError.stdout).trim();
  const stderr = toOutputString(commandError.stderr).trim();

  const timedOut =
    commandError.code === "ETIMEDOUT" ||
    /timed out/i.test(commandError.message);

  const parts: string[] = [];

  if (timedOut) {
    parts.push(
      `Docker command timed out after ${Math.ceil(timeoutMs / 1_000)} seconds.`,
    );
  } else if (commandError.code !== undefined) {
    parts.push(
      `Docker command failed (code ${String(commandError.code)}).`,
    );
  }

  if (stderr) {
    parts.push(`Docker stderr:\n${stderr}`);
  }

  if (stdout) {
    parts.push(`Docker stdout:\n${stdout}`);
  }

  if (parts.length === 0 || (!stdout && !stderr && !timedOut)) {
    parts.push(commandError.message);
  }

  return parts
    .join("\n")
    .slice(-MAX_ERROR_MESSAGE_LENGTH);
};

/**
 * Runs a Docker CLI command with an explicit timeout.
 *
 * Image pulls get a longer timeout than ordinary container operations.
 */
const runDocker = async (
  args: readonly string[],
  timeoutMs = DOCKER_COMMAND_TIMEOUT_MS,
): Promise<string> => {
  try {
    const { stdout } = await execFileAsync("docker", [...args], {
      encoding: "utf8",
      maxBuffer: MAX_DOCKER_OUTPUT_BYTES,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      windowsHide: true,
    });

    return stdout;
  } catch (error: unknown) {
    throw new Error(sanitizeError(error, timeoutMs));
  }
};

export type DockerContainer = {
  id: string;
};

export type CommandExecutionResult = {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

type OutputHandler = (chunk: Buffer) => Promise<void> | void;

type ExecuteCommandInput = {
  containerId: string;
  command: string;
  timeoutMs: number;
  onStdout?: OutputHandler;
  onStderr?: OutputHandler;
};

const appendOutput = (
  current: string,
  chunk: Buffer,
): string => {
  if (current.length >= MAX_CAPTURED_LOG_BYTES) {
    return current;
  }

  const remaining = MAX_CAPTURED_LOG_BYTES - current.length;

  return current + chunk.toString("utf8").slice(0, remaining);
};

/**
 * Ensure the requested image exists locally.
 *
 * Existing images are reused without contacting the registry.
 * Missing images are pulled with a longer timeout.
 */
const ensureJobImageAvailable = async (
  image: string,
): Promise<void> => {
  try {
    await runDocker(["image", "inspect", image]);
    return;
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error);

    const imageDoesNotExist =
      /no such image|no such object|image not found/i.test(message);

    if (!imageDoesNotExist) {
      throw error;
    }
  }

  await runDocker(
    ["pull", image],
    DOCKER_IMAGE_PULL_TIMEOUT_MS,
  );
};

/**
 * Creates a fresh container for exactly one job attempt.
 *
 * The repository workspace is the only host path mounted into the
 * container. The image is pulled before container creation so that
 * downloading it does not use the short container-command timeout.
 */
export const createJobContainer = async (
  workspacePath: string,
  image = DEFAULT_JOB_IMAGE,
): Promise<DockerContainer> => {
  await ensureJobImageAvailable(image);

  const output = await runDocker([
    "run",
    "--detach",
    "--pull",
    "never",
    "--workdir",
    "/workspace",
    "--mount",
    `type=bind,source=${workspacePath},target=/workspace`,
    image,
    "tail",
    "-f",
    "/dev/null",
  ]);

  const containerId = output.trim();

  if (!containerId) {
    throw new Error("Docker did not return a container ID");
  }

  return { id: containerId };
};

const killJobContainer = async (
  containerId: string,
): Promise<void> => {
  try {
    await runDocker(["kill", containerId]);
  } catch {
    // The container may already have exited.
  }
};

export const removeJobContainer = async (
  containerId: string,
): Promise<void> => {
  try {
    await runDocker(["rm", "--force", containerId]);
  } catch {
    // Cleanup must not hide the original execution result.
  }
};

const executeCommand = async ({
  containerId,
  command,
  timeoutMs,
  onStdout,
  onStderr,
}: ExecuteCommandInput): Promise<CommandExecutionResult> => {
  if (timeoutMs <= 0) {
    return {
      exitCode: null,
      timedOut: true,
      stdout: "",
      stderr: "Job execution timeout exceeded",
    };
  }

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let outputError: Error | null = null;

    let stdoutTail: Promise<void> = Promise.resolve();
    let stderrTail: Promise<void> = Promise.resolve();

    const child = spawn(
      "docker",
      ["exec", containerId, "/bin/sh", "-lc", command],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      timedOut = true;

      // Stop the docker exec client immediately, then stop the container.
      child.kill();
      void killJobContainer(containerId);
    }, timeoutMs);

    const enqueueOutput = (
      streamName: "stdout" | "stderr",
      stream: Readable,
      chunk: Buffer,
      handler: OutputHandler | undefined,
    ): void => {
      if (!handler) {
        return;
      }

      // Pause the stream while its durable log write is in progress.
      // This applies backpressure instead of accumulating unlimited writes.
      stream.pause();

      const previousTail =
        streamName === "stdout" ? stdoutTail : stderrTail;

      const nextTail = previousTail
        .then(async () => {
          if (!outputError) {
            await handler(Buffer.from(chunk));
          }
        })
        .catch((error: unknown) => {
          outputError =
            error instanceof Error
              ? error
              : new Error(
                  `Failed to persist ${streamName} output`,
                );

          child.kill();
          void killJobContainer(containerId);
        })
        .finally(() => {
          stream.resume();
        });

      if (streamName === "stdout") {
        stdoutTail = nextTail;
      } else {
        stderrTail = nextTail;
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk);
      enqueueOutput("stdout", child.stdout, chunk, onStdout);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk);
      enqueueOutput("stderr", child.stderr, chunk, onStderr);
    });

    child.on("error", (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      reject(error);
    });

    child.on("close", (code: number | null) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      void Promise.all([stdoutTail, stderrTail]).then(() => {
        if (outputError) {
          reject(outputError);
          return;
        }

        if (timedOut) {
          resolve({
            exitCode: null,
            timedOut: true,
            stdout,
            stderr: stderr || "Job execution timed out",
          });
          return;
        }

        resolve({
          exitCode: code,
          timedOut: false,
          stdout,
          stderr,
        });
      });
    });
  });
};

export type ExecuteCommandsResult = {
  success: boolean;
  timedOut: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type ExecuteCommandsOptions = {
  onStdout?: OutputHandler;
  onStderr?: OutputHandler;
};

/**
 * Executes commands sequentially inside the same fresh container.
 *
 * The timeout covers the complete command execution phase, not queue
 * waiting, repository checkout, or image download.
 */
export const executeCommands = async (
  containerId: string,
  commands: readonly string[],
  timeoutSeconds: number,
  options: ExecuteCommandsOptions = {},
): Promise<ExecuteCommandsResult> => {
  const timeoutMs = timeoutSeconds * 1_000;
  const deadline = Date.now() + timeoutMs;

  let allStdout = "";
  let allStderr = "";

  for (const command of commands) {
    const remainingMs = deadline - Date.now();

    if (remainingMs <= 0) {
      await killJobContainer(containerId);

      return {
        success: false,
        timedOut: true,
        exitCode: null,
        stdout: allStdout,
        stderr: allStderr || "Job execution timed out",
      };
    }

    const result = await executeCommand({
      containerId,
      command,
      timeoutMs: remainingMs,
      ...(options.onStdout !== undefined
        ? { onStdout: options.onStdout }
        : {}),
      ...(options.onStderr !== undefined
        ? { onStderr: options.onStderr }
        : {}),
    });

    allStdout = appendOutput(
      allStdout,
      Buffer.from(result.stdout),
    );

    allStderr = appendOutput(
      allStderr,
      Buffer.from(result.stderr),
    );

    if (result.timedOut) {
      return {
        success: false,
        timedOut: true,
        exitCode: null,
        stdout: allStdout,
        stderr: allStderr || "Job execution timed out",
      };
    }

    if (result.exitCode !== 0) {
      return {
        success: false,
        timedOut: false,
        exitCode: result.exitCode,
        stdout: allStdout,
        stderr: allStderr,
      };
    }
  }

  return {
    success: true,
    timedOut: false,
    exitCode: 0,
    stdout: allStdout,
    stderr: allStderr,
  };
};