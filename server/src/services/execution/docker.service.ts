import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DOCKER_COMMAND_TIMEOUT_MS = 30_000;
const MAX_DOCKER_OUTPUT_BYTES = 1024 * 1024;
const MAX_CAPTURED_LOG_BYTES = 10 * 1024 * 1024;

export const DEFAULT_JOB_IMAGE =
  process.env.DEPLOYBENCH_JOB_IMAGE ?? "node:24-bookworm";

const sanitizeError = (error: unknown): string => {
  const message =
    error instanceof Error ? error.message : "Docker command failed";

  return message.slice(0, 2_000);
};

const runDocker = async (
  args: readonly string[],
): Promise<string> => {
  try {
    const { stdout } = await execFileAsync("docker", [...args], {
      encoding: "utf8",
      maxBuffer: MAX_DOCKER_OUTPUT_BYTES,
      timeout: DOCKER_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });

    return stdout;
  } catch (error) {
    throw new Error(sanitizeError(error));
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

type ExecuteCommandInput = {
  containerId: string;
  command: string;
  timeoutMs: number;
};

const appendOutput = (
  current: string,
  chunk: Buffer,
): string => {
  if (current.length >= MAX_CAPTURED_LOG_BYTES) {
    return current;
  }

  const remaining =
    MAX_CAPTURED_LOG_BYTES - current.length;

  return current + chunk.toString("utf8").slice(0, remaining);
};

/**
 * Creates a fresh container for exactly one job attempt.
 *
 * The repository workspace is the only host path mounted into the
 * container.
 */
export const createJobContainer = async (
  workspacePath: string,
  image = DEFAULT_JOB_IMAGE,
): Promise<DockerContainer> => {
  const output = await runDocker([
    "run",
    "--detach",
    "--pull",
    "missing",
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
    await runDocker([
      "kill",
      containerId,
    ]);
  } catch {
    // The container may already have exited.
  }
};

export const removeJobContainer = async (
  containerId: string,
): Promise<void> => {
  try {
    await runDocker([
      "rm",
      "--force",
      containerId,
    ]);
  } catch {
    // Cleanup must not hide the original execution result.
  }
};

const executeCommand = async ({
  containerId,
  command,
  timeoutMs,
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

    const child = spawn(
      "docker",
      [
        "exec",
        containerId,
        "/bin/sh",
        "-lc",
        command,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    const timer = setTimeout(() => {
      if (settled) return;

      timedOut = true;

      void killJobContainer(containerId).finally(() => {
        child.kill();
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk);
    });

    child.on("error", (error) => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      reject(new Error(sanitizeError(error)));
    });

    child.on("close", (code) => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);

      if (timedOut) {
        resolve({
          exitCode: null,
          timedOut: true,
          stdout,
          stderr:
            stderr || "Job execution timed out",
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
};

export type ExecuteCommandsResult = {
  success: boolean;
  timedOut: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

/**
 * Executes commands sequentially inside the same fresh container.
 *
 * The timeout is one timeout for the actual command execution phase,
 * not queue waiting time or repository checkout time.
 */
export const executeCommands = async (
  containerId: string,
  commands: readonly string[],
  timeoutSeconds: number,
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
        stderr:
          allStderr || "Job execution timed out",
      };
    }

    const result = await executeCommand({
      containerId,
      command,
      timeoutMs: remainingMs,
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
        stderr:
          allStderr || "Job execution timed out",
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