import { spawn } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isIP } from "node:net";
import {
  ECRClient,
  GetAuthorizationTokenCommand,
} from "@aws-sdk/client-ecr";

import { AppError } from "../../utils/app.error.js";
import { getEnvironmentSecretValue, resolveProjectEcrCredentials } from "./deployment-credentials.service.js";
import { checkDeploymentHealth, type HealthCheckResult } from "./health-check.service.js";
import type {
  DeploymentExecutionInput,
  DeploymentTargetExecutor,
} from "../../workers/deployment.worker.js";

interface SshTargetConfig {
  host: string;
  sshPort: number;
  username: string;
  privateKeySecretName: string;
  knownHostsSecretName: string;
  containerName: string;
  hostPort: number;
  containerPort: number;
  envFileSecretName?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readRequiredString = (
  config: Record<string, unknown>,
  key: string,
  maxLength: number,
): string => {
  const value = config[key];
  if (typeof value !== "string") {
    throw new AppError(`SSH EC2 targetConfig.${key} must be a string`, 400);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new AppError(`SSH EC2 targetConfig.${key} is empty or too long`, 400);
  }
  return normalized;
};

const readPort = (
  config: Record<string, unknown>,
  key: string,
  defaultValue: number,
): number => {
  const raw = config[key] ?? defaultValue;
  const value = typeof raw === "number"
    ? raw
    : typeof raw === "string" && /^\d+$/.test(raw.trim())
      ? Number(raw)
      : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new AppError(`SSH EC2 targetConfig.${key} must be a port between 1 and 65535`, 400);
  }
  return value;
};

const parseSshTargetConfig = (value: unknown): SshTargetConfig => {
  if (!isRecord(value)) {
    throw new AppError("SSH EC2 environment targetConfig must be an object", 400);
  }

  const host = readRequiredString(value, "host", 255);
  const looksLikeIpv4 = /^\d+(?:\.\d+){3}$/.test(host);
  const hostIsValid = isIP(host) !== 0 || (!looksLikeIpv4 && /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/.test(host));
  if (
    host.startsWith("-") ||
    /[\s\u0000-\u001f\u007f]/.test(host) ||
    !hostIsValid
  ) {
    throw new AppError("SSH EC2 target host must be a valid IP address or DNS hostname", 400);
  }

  const username = readRequiredString(value, "username", 32);
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(username)) {
    throw new AppError("SSH EC2 username is invalid", 400);
  }

  const privateKeySecretName = readRequiredString(value, "privateKeySecretName", 128);
  const knownHostsSecretName = readRequiredString(value, "knownHostsSecretName", 128);
  const containerName = readRequiredString(value, "containerName", 48);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/.test(containerName)) {
    throw new AppError("SSH EC2 containerName is invalid", 400);
  }

  const envFileSecretNameValue = value.envFileSecretName;
  let envFileSecretName: string | undefined;
  if (envFileSecretNameValue !== undefined && envFileSecretNameValue !== null && envFileSecretNameValue !== "") {
    if (typeof envFileSecretNameValue !== "string" || envFileSecretNameValue.trim().length === 0 || envFileSecretNameValue.length > 128) {
      throw new AppError("SSH EC2 envFileSecretName is invalid", 400);
    }
    envFileSecretName = envFileSecretNameValue.trim();
  }

  return {
    host,
    sshPort: readPort(value, "sshPort", 22),
    username,
    privateKeySecretName,
    knownHostsSecretName,
    containerName,
    hostPort: readPort(value, "hostPort", 80),
    containerPort: readPort(value, "containerPort", 3000),
    ...(envFileSecretName === undefined ? {} : { envFileSecretName }),
  };
};



const quoteShell = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

const appendTail = (current: string, chunk: Buffer, maxChars = 12_000): string =>
  `${current}${chunk.toString("utf8")}`.slice(-maxChars);

const runSshScript = async ({
  config,
  keyPath,
  knownHostsPath,
  script,
  signal,
  timeoutMs,
}: {
  config: SshTargetConfig;
  keyPath: string;
  knownHostsPath: string;
  script: string;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<string> => {
  if (signal.aborted) throw new AppError("SSH deployment was canceled", 499);

  return new Promise<string>((resolvePromise, rejectPromise) => {
    let stderr = "";
    let stdout = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const args = [
      "-i", keyPath,
      "-p", String(config.sshPort),
      "-o", "BatchMode=yes",
      "-o", "IdentitiesOnly=yes",
      "-o", "PasswordAuthentication=no",
      "-o", "PreferredAuthentications=publickey",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${knownHostsPath}`,
      "-o", "ConnectTimeout=15",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      `${config.username}@${config.host}`,
      "bash", "-s",
    ];

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error: unknown) {
      rejectPromise(error);
      return;
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timeout);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      signal.removeEventListener("abort", onAbort);
    };

    const finish = (error?: Error, output = ""): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectPromise(error);
      else resolvePromise(output);
    };

    const onAbort = (): void => {
      aborted = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    child.on("error", (error: NodeJS.ErrnoException) => {
      const message = error.code === "ENOENT"
        ? "OpenSSH client 'ssh' is required on the DeployBench worker host"
        : `Could not start SSH deployment: ${error.message}`;
      finish(new AppError(message, 500));
    });
    child.on("close", (code) => {
      if (aborted) {
        finish(new AppError("SSH deployment was canceled", 499));
        return;
      }
      if (timedOut) {
        finish(new AppError(`SSH deployment timed out after ${timeoutMs} ms`, 504));
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || "remote command returned a non-zero exit code";
        finish(new AppError(`SSH deployment command failed (exit ${code ?? "unknown"}): ${detail.slice(-2_000)}`, 502));
        return;
      }
      finish(undefined, stdout);
    });

    // Even with stdio configured as pipes, Node's type declarations correctly
    // model these streams as nullable. Guard them before registering handlers.
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    const stdinStream = child.stdin;
    if (!stdoutStream || !stderrStream || !stdinStream) {
      child.kill("SIGKILL");
      finish(new AppError("SSH process did not expose the required piped stdio streams", 500));
      return;
    }

    stdoutStream.on("data", (chunk: Buffer) => {
      stdout = appendTail(stdout, chunk);
    });
    stderrStream.on("data", (chunk: Buffer) => {
      stderr = appendTail(stderr, chunk);
    });
    stdinStream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") {
        finish(new AppError(`Could not send deployment script over SSH: ${error.message}`, 502));
      }
    });
    stdinStream.end(script);
  });
};

const getEcrPassword = async (projectId: string, registry: string): Promise<{ region: string; password: string }> => {
  const match = /^([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/i.exec(registry);
  const accountId = match?.[1];
  const region = match?.[2]?.toLowerCase();
  if (!accountId || !region) {
    throw new AppError("Container image registry is not a valid ECR registry", 409);
  }
  const credentials = await resolveProjectEcrCredentials(projectId);
  const client = new ECRClient({
    region,
    credentials,
  });
  try {
    const response = await client.send(new GetAuthorizationTokenCommand({ registryIds: [accountId] }));
    const token = response.authorizationData?.[0]?.authorizationToken;
    if (!token) throw new AppError("Amazon ECR did not return an authorization token", 502);

    const decoded = Buffer.from(token, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator <= 0 || decoded.slice(0, separator) !== "AWS" || separator === decoded.length - 1) {
      throw new AppError("Amazon ECR returned invalid authorization credentials", 502);
    }
    return { region, password: decoded.slice(separator + 1) };
  } finally {
    client.destroy();
  }
};

const buildDeployScript = ({
  config,
  registry,
  imageReference,
  ecrPassword,
  previousContainerName,
  deploymentId,
  envFileContent,
}: {
  config: SshTargetConfig;
  registry: string;
  imageReference: string;
  ecrPassword: string;
  previousContainerName: string;
  deploymentId: string;
  envFileContent: string | null;
}): string => {
  const encodedPassword = Buffer.from(ecrPassword, "utf8").toString("base64");
  const encodedEnvFile = envFileContent === null
    ? null
    : Buffer.from(envFileContent, "utf8").toString("base64");
  const envFileBlock = encodedEnvFile === null
    ? "ENV_FILE=''\n"
    : [
        'ENV_DIR="$HOME/.deploybench/$NAME"',
        'mkdir -p "$ENV_DIR"',
        'ENV_FILE="$ENV_DIR/$DEPLOYMENT_ID.env"',
        `printf '%s' ${quoteShell(encodedEnvFile)} | base64 -d > "$ENV_FILE"`,
        'chmod 600 "$ENV_FILE"',
      ].join("\n") + "\n";

  return [
    "set -eu",
    `NAME=${quoteShell(config.containerName)}`,
    `PREVIOUS=${quoteShell(previousContainerName)}`,
    `DEPLOYMENT_ID=${quoteShell(deploymentId)}`,
    `IMAGE=${quoteShell(imageReference)}`,
    `REGISTRY=${quoteShell(registry)}`,
    `ECR_PASSWORD_B64=${quoteShell(encodedPassword)}`,
    'DOCKER_CONFIG=$(mktemp -d)',
    'export DOCKER_CONFIG',
    'cleanup_ecr_auth() { docker logout "$REGISTRY" >/dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG"; }',
    'trap cleanup_ecr_auth EXIT',
    envFileBlock.trimEnd(),
    "command -v docker >/dev/null 2>&1 || { echo 'Docker is not installed on the EC2 target' >&2; exit 127; }",
    "printf '%s' \"$ECR_PASSWORD_B64\" | base64 -d | docker login \"$REGISTRY\" --username AWS --password-stdin >/dev/null",
    "docker pull \"$IMAGE\"",
    "if docker inspect \"$NAME\" >/dev/null 2>&1; then",
    "  current_image=$(docker inspect --format '{{.Config.Image}}' \"$NAME\")",
    "  current_deployment_id=$(docker inspect --format '{{ index .Config.Labels \"deploybench.deployment-id\" }}' \"$NAME\" 2>/dev/null || true)",
    "  if [ \"$current_image\" = \"$IMAGE\" ] && [ \"$current_deployment_id\" = \"$DEPLOYMENT_ID\" ] && [ \"$(docker inspect --format '{{.State.Running}}' \"$NAME\")\" = 'true' ]; then",
    '    if [ -n "${ENV_FILE:-}" ]; then rm -f "$ENV_FILE"; fi',
    "    echo 'DEPLOYBENCH_ALREADY_RUNNING'",
    "    exit 0",
    "  fi",
    "fi",
    "if docker inspect \"$PREVIOUS\" >/dev/null 2>&1; then",
    "  echo 'A backup container for this deployment already exists; refusing to overwrite it automatically' >&2",
    "  exit 75",
    "fi",
    "HAD_PREVIOUS=0",
    "if docker inspect \"$NAME\" >/dev/null 2>&1; then",
    "  docker stop -t 20 \"$NAME\" >/dev/null",
    "  docker rename \"$NAME\" \"$PREVIOUS\"",
    "  HAD_PREVIOUS=1",
    "fi",
    "set +e",
    `if [ -n "\${ENV_FILE:-}" ]; then docker run -d --name \"$NAME\" --label \"deploybench.deployment-id=$DEPLOYMENT_ID\" --restart unless-stopped -p ${config.hostPort}:${config.containerPort} --env-file \"$ENV_FILE\" \"$IMAGE\"; else docker run -d --name \"$NAME\" --label \"deploybench.deployment-id=$DEPLOYMENT_ID\" --restart unless-stopped -p ${config.hostPort}:${config.containerPort} \"$IMAGE\"; fi`,
    "run_status=$?",
    "set -e",
    "if [ \"$run_status\" -ne 0 ]; then",
    "  docker rm -f \"$NAME\" >/dev/null 2>&1 || true",
    "  if [ \"$HAD_PREVIOUS\" -eq 1 ]; then docker rename \"$PREVIOUS\" \"$NAME\"; docker start \"$NAME\" >/dev/null; fi",
    '  if [ -n "${ENV_FILE:-}" ]; then rm -f "$ENV_FILE"; fi',
    "  exit \"$run_status\"",
    "fi",
    'if [ -n "${ENV_FILE:-}" ]; then rm -f "$ENV_FILE"; fi',
    `echo 'DeployBench deployment ${deploymentId} started'`,
    "",
  ].join("\n");
};

const restorePreviousContainer = async ({
  config,
  keyPath,
  knownHostsPath,
  previousContainerName,
  deploymentId,
  signal,
}: {
  config: SshTargetConfig;
  keyPath: string;
  knownHostsPath: string;
  previousContainerName: string;
  deploymentId: string;
  signal: AbortSignal;
}): Promise<void> => {
  const script = [
    "set -eu",
    `NAME=${quoteShell(config.containerName)}`,
    `PREVIOUS=${quoteShell(previousContainerName)}`,
    `DEPLOYMENT_ID=${quoteShell(deploymentId)}`,
    "if docker inspect \"$NAME\" >/dev/null 2>&1; then",
    "  current_deployment_id=$(docker inspect --format '{{ index .Config.Labels \"deploybench.deployment-id\" }}' \"$NAME\" 2>/dev/null || true)",
    "  if [ \"$current_deployment_id\" = \"$DEPLOYMENT_ID\" ]; then",
    "    docker rm -f \"$NAME\" >/dev/null",
    "  elif docker inspect \"$PREVIOUS\" >/dev/null 2>&1; then",
    "    echo 'Refusing to remove a container that does not belong to this deployment' >&2",
    "    exit 78",
    "  else",
    "    rm -f \"$HOME/.deploybench/$NAME/$DEPLOYMENT_ID.env\"",
    "    exit 0",
    "  fi",
    "fi",
    "if docker inspect \"$PREVIOUS\" >/dev/null 2>&1; then docker rename \"$PREVIOUS\" \"$NAME\"; docker start \"$NAME\" >/dev/null; fi",
    "rm -f \"$HOME/.deploybench/$NAME/$DEPLOYMENT_ID.env\"",
    "",
  ].join("\n");
  await runSshScript({
    config,
    keyPath,
    knownHostsPath,
    script,
    signal,
    timeoutMs: 60_000,
  });
};

const pruneOldBackupContainers = async ({
  config,
  keyPath,
  knownHostsPath,
  preserveName,
  signal,
}: {
  config: SshTargetConfig;
  keyPath: string;
  knownHostsPath: string;
  preserveName: string;
  signal: AbortSignal;
}): Promise<void> => {
  const script = [
    "set -eu",
    `NAME=${quoteShell(config.containerName)}`,
    `PRESERVE=${quoteShell(preserveName)}`,
    `for id in $(docker ps -aq --filter \"name=^/$NAME-prev-\"); do`,
    "  name=$(docker inspect --format '{{.Name}}' \"$id\" | sed 's#^/##')",
    "  if [ \"$name\" != \"$PRESERVE\" ]; then",
    "    old_deployment_id=$(docker inspect --format '{{ index .Config.Labels \"deploybench.deployment-id\" }}' \"$id\" 2>/dev/null || true)",
    "    if printf '%s' \"$old_deployment_id\" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'; then",
    "      docker rm -f \"$id\" >/dev/null 2>&1 || true",
    "      rm -f \"$HOME/.deploybench/$NAME/$old_deployment_id.env\"",
    "    else echo \"Skipping unowned backup container $name\" >&2; fi",
    "  fi",
    "done",
    "",
  ].join("\n");
  await runSshScript({
    config,
    keyPath,
    knownHostsPath,
    script,
    signal,
    timeoutMs: 60_000,
  });
};

export class SshEc2ContainerExecutor implements DeploymentTargetExecutor {
  async deploy(input: DeploymentExecutionInput): Promise<void> {
    const { deployment, environment, containerImage, signal } = input;
    if (environment.targetType !== "ssh_ec2") {
      throw new AppError("SSH EC2 executor received a non-EC2 environment", 500);
    }
    if (!containerImage || containerImage.id !== deployment.containerImageId) {
      throw new AppError("EC2 deployment requires a container image matching the deployment", 409);
    }
    if (!/^sha256:[a-f0-9]{64}$/i.test(containerImage.digest)) {
      throw new AppError("EC2 deployment image digest is invalid", 409);
    }
    if (signal.aborted) throw new AppError("Deployment was canceled before SSH setup", 499);

    const config = parseSshTargetConfig(environment.targetConfig);
    const privateKey = await getEnvironmentSecretValue(environment.projectId, environment.id, config.privateKeySecretName);
    const knownHosts = await getEnvironmentSecretValue(environment.projectId, environment.id, config.knownHostsSecretName);
    const envFileContent = config.envFileSecretName === undefined
      ? null
      : await getEnvironmentSecretValue(environment.projectId, environment.id, config.envFileSecretName);
    if (privateKey.includes("\0") || knownHosts.includes("\0") || (envFileContent?.includes("\0") ?? false)) {
      throw new AppError("Environment SSH secrets contain invalid null bytes", 400);
    }
    if (!knownHosts.split(/\r?\n/).some((line) => line.trim().length > 0 && !line.trimStart().startsWith("#"))) {
      throw new AppError("Known-hosts secret does not contain any host keys", 400);
    }

    const registry = containerImage.registry.trim().toLowerCase();
    const imageReference = `${registry}/${containerImage.repository}@${containerImage.digest.toLowerCase()}`;
    if (imageReference.length > 512 || /\s/.test(imageReference)) {
      throw new AppError("EC2 deployment image reference is invalid", 409);
    }

    const ecrAuth = await getEcrPassword(environment.projectId, registry);
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "deploybench-ssh-"));
    const keyPath = join(temporaryDirectory, "id_deploybench");
    const knownHostsPath = join(temporaryDirectory, "known_hosts");
    const previousContainerName = `${config.containerName}-prev-${deployment.id.slice(0, 8)}`;
    let remoteDeployStarted = false;
    let rollbackAttempted = false;
    let deploymentWasAlreadyRunning = false;
    const restoreCurrentDeployment = async (): Promise<void> => {
      if (deploymentWasAlreadyRunning) return;
      if (rollbackAttempted) return;
      rollbackAttempted = true;
      await restorePreviousContainer({
        config,
        keyPath,
        knownHostsPath,
        previousContainerName,
        deploymentId: deployment.id,
        signal: signal.aborted ? new AbortController().signal : signal,
      });
    };

    try {
      await writeFile(keyPath, `${privateKey.replace(/\r\n/g, "\n").trim()}\n`, { mode: 0o600, flag: "wx" });
      await writeFile(knownHostsPath, `${knownHosts.replace(/\r\n/g, "\n").trim()}\n`, { mode: 0o600, flag: "wx" });

      remoteDeployStarted = true;
      const deployOutput = await runSshScript({
        config,
        keyPath,
        knownHostsPath,
        script: buildDeployScript({
          config,
          registry,
          imageReference,
          ecrPassword: ecrAuth.password,
          previousContainerName,
          deploymentId: deployment.id,
          envFileContent,
        }),
        signal,
        // Pulling a large image may take substantially longer than the health-check window.
        timeoutMs: 15 * 60_000,
      });
      deploymentWasAlreadyRunning = deployOutput.includes("DEPLOYBENCH_ALREADY_RUNNING");

      // Keep the prior container stopped until the target health check passes.
      // If health fails, restore the old container before surfacing deployment failure.
      let health: HealthCheckResult;
      try {
        health = await checkDeploymentHealth({ environment, signal });
      } catch (healthError: unknown) {
        if (!deploymentWasAlreadyRunning) {
          try {
            await restoreCurrentDeployment();
          } catch (restoreError: unknown) {
            const restoreMessage = restoreError instanceof Error ? restoreError.message : "unknown restore error";
            throw new AppError(`Health verification failed and automatic EC2 rollback also failed: ${restoreMessage}`, 502);
          }
        }
        throw healthError;
      }

      if (!health.healthy) {
        if (!deploymentWasAlreadyRunning) {
          try {
            await restoreCurrentDeployment();
          } catch (restoreError: unknown) {
            const restoreMessage = restoreError instanceof Error ? restoreError.message : "unknown restore error";
            throw new AppError(`EC2 health check failed and automatic rollback also failed: ${restoreMessage}`, 502);
          }
        }
        const recoveryNote = deploymentWasAlreadyRunning
          ? "The requested image was already running; the existing container was left in place."
          : "The previous container was restored.";
        throw new AppError(`EC2 deployment health check failed. ${recoveryNote} ${health.message}`, 502);
      }

      if (!deploymentWasAlreadyRunning) {
        await pruneOldBackupContainers({
          config,
          keyPath,
          knownHostsPath,
          preserveName: previousContainerName,
          signal,
        }).catch((cleanupError: unknown) => {
          // A cleanup failure must not turn an otherwise healthy deployment into a failed release.
          console.error("Failed to prune old EC2 deployment containers", {
            deploymentId: deployment.id,
            cleanupError,
          });
        });
      }
    } catch (error: unknown) {
      // If SSH timed out after the remote command had switched containers, make one best-effort restore.
      if (remoteDeployStarted && !deploymentWasAlreadyRunning && !rollbackAttempted) {
        await restoreCurrentDeployment().catch((restoreError: unknown) => {
          console.error("Failed to restore EC2 container after an interrupted deployment", {
            deploymentId: deployment.id,
            restoreError,
          });
        });
      }
      throw error;
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch((cleanupError: unknown) => {
        console.error("Failed to clean temporary SSH deployment credentials", {
          deploymentId: deployment.id,
          cleanupError,
        });
      });
    }
  }
}
