import { AppError } from "../../utils/app.error.js";
import type { EnvironmentRow } from "./deployment.service.js";

export interface HealthCheckInput {
  environment: EnvironmentRow;
  signal?: AbortSignal;
}

export interface HealthCheckResult {
  checked: boolean;
  healthy: boolean;
  statusCode: number | null;
  attempts: number;
  elapsedMs: number;
  message: string;
}

const INITIAL_DELAY_MS = 2_000;
const RETRY_DELAY_MS = 1_000;
const MAX_ATTEMPTS = 6;
const MAX_RESPONSE_BODY_BYTES = 8 * 1024;
const MAX_ERROR_MESSAGE_LENGTH = 2_000;

const sleep = async (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> => {
  if (milliseconds <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError("Deployment health check was canceled", 499));
      return;
    }

    let settled = false;

    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve();
    }, milliseconds);

    const onAbort = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(new AppError("Deployment health check was canceled", 499));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

const getRemainingMs = (deadline: number): number =>
  Math.max(0, deadline - Date.now());

const validateHealthCheckUrl = (healthCheckUrl: string): URL => {
  let url: URL;

  try {
    url = new URL(healthCheckUrl);
  } catch {
    throw new AppError("Environment health check URL is invalid", 500);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(
      "Environment health check URL must use HTTP or HTTPS",
      500,
    );
  }

  return url;
};

const readSmallResponseBody = async (response: Response): Promise<string> => {
  if (!response.body) {
    return "";
  }

  try {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    while (total < MAX_RESPONSE_BODY_BYTES) {
      const { done, value } = await reader.read();

      if (done || value === undefined) {
        break;
      }

      const remaining = MAX_RESPONSE_BODY_BYTES - total;
      const chunk =
        value.byteLength > remaining ? value.slice(0, remaining) : value;

      chunks.push(chunk);
      total += chunk.byteLength;

      if (total >= MAX_RESPONSE_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }

    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
      "utf8",
    );
  } catch {
    return "";
  }
};

export const checkDeploymentHealth = async ({
  environment,
  signal,
}: HealthCheckInput): Promise<HealthCheckResult> => {
  const startedAt = Date.now();

  if (environment.targetType === "s3" && environment.healthCheckUrl === null) {
    return {
      checked: false,
      healthy: true,
      statusCode: null,
      attempts: 0,
      elapsedMs: 0,
      message: "No health check configured for this S3 environment",
    };
  }

  if (environment.healthCheckUrl === null) {
    throw new AppError(
      "ssh_ec2 environment is missing its required health check URL",
      500,
    );
  }

  const url = validateHealthCheckUrl(environment.healthCheckUrl);
  const timeoutMs = environment.healthCheckTimeoutSeconds * 1_000;
  const deadline = startedAt + timeoutMs;

  if (signal?.aborted) {
    throw new AppError("Deployment health check was canceled", 499);
  }

  const initialDelayMs = Math.min(
    INITIAL_DELAY_MS,
    Math.max(0, timeoutMs - 250),
  );

  if (initialDelayMs > 0) {
    await sleep(initialDelayMs, signal);
  }

  let lastStatusCode: number | null = null;
  let lastMessage = "Health check did not succeed";
  let attempts = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const remainingMs = getRemainingMs(deadline);

    if (remainingMs <= 0) {
      break;
    }

    attempts = attempt;

    if (signal?.aborted) {
      throw new AppError("Deployment health check was canceled", 499);
    }

    const requestController = new AbortController();
    let requestTimedOut = false;

    const timeout = setTimeout(() => {
      requestTimedOut = true;
      requestController.abort();
    }, remainingMs);

    const abortFromParent = (): void => {
      requestController.abort();
    };

    signal?.addEventListener("abort", abortFromParent, { once: true });

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json, text/plain, */*",
        },
        redirect: "follow",
        signal: requestController.signal,
      });

      lastStatusCode = response.status;

      if (response.ok) {
        await response.body?.cancel().catch(() => undefined);

        return {
          checked: true,
          healthy: true,
          statusCode: response.status,
          attempts,
          elapsedMs: Date.now() - startedAt,
          message: "Health check succeeded",
        };
      }

      const body = await readSmallResponseBody(response);
      const detail = body.trim().slice(0, MAX_ERROR_MESSAGE_LENGTH);

      lastMessage = detail
        ? `Health check returned HTTP ${response.status}: ${detail}`
        : `Health check returned HTTP ${response.status}`;
    } catch (error: unknown) {
      if (signal?.aborted) {
        throw new AppError("Deployment health check was canceled", 499);
      }

      if (
        requestTimedOut ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        lastMessage = "Health check request timed out";
      } else {
        lastMessage =
          error instanceof Error
            ? error.message
            : "Health check request failed";
      }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromParent);
    }

    const remainingAfterAttemptMs = getRemainingMs(deadline);

    if (attempt < MAX_ATTEMPTS && remainingAfterAttemptMs > 0) {
      await sleep(Math.min(RETRY_DELAY_MS, remainingAfterAttemptMs), signal);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const suffix =
    lastStatusCode === null
      ? ""
      : ` (last HTTP status ${lastStatusCode})`;

  return {
    checked: true,
    healthy: false,
    statusCode: lastStatusCode,
    attempts,
    elapsedMs,
    message: `${lastMessage}${suffix}`.slice(0, MAX_ERROR_MESSAGE_LENGTH),
  };
};
