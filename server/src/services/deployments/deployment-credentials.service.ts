import { and, eq, isNull } from "drizzle-orm";

import { env } from "../../config/env.js";
import { db } from "../../db/index.js";
import { environments, secrets } from "../../db/schema.js";
import { AppError } from "../../utils/app.error.js";
import { decryptSecret } from "../secrets/secret.service.js";

export interface AwsDeploymentCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

type SecretScopeReader = (name: string) => Promise<string | null>;

type CredentialNames = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  description: string;
};

const readDecryptedSecret = async (
  row: Pick<typeof secrets.$inferSelect, "cipherText" | "iv" | "authTag"> | undefined,
  name: string,
): Promise<string | null> => {
  if (row === undefined) return null;

  let value: string;
  try {
    value = decryptSecret(row);
  } catch {
    throw new AppError(`Could not decrypt configured secret "${name}"`, 500);
  }

  if (value.trim().length === 0) {
    throw new AppError(`Configured secret "${name}" is empty`, 409);
  }

  return value;
};

/**
 * Internal worker-only secret read. Public Secrets API responses contain metadata
 * only; this function is used by trusted deployment workers after environment
 * ownership has already been resolved from the database.
 */
export const getEnvironmentSecretValue = async (
  projectId: string,
  environmentId: string,
  name: string,
): Promise<string> => {
  const [row] = await db
    .select({
      cipherText: secrets.cipherText,
      iv: secrets.iv,
      authTag: secrets.authTag,
    })
    .from(secrets)
    .innerJoin(environments, eq(secrets.environmentId, environments.id))
    .where(
      and(
        eq(environments.id, environmentId),
        eq(environments.projectId, projectId),
        eq(secrets.environmentId, environmentId),
        eq(secrets.name, name),
        isNull(secrets.projectId),
      ),
    )
    .limit(1);

  const value = await readDecryptedSecret(row, name);
  if (value === null) {
    throw new AppError(`Environment secret "${name}" was not found`, 409);
  }
  return value;
};

/** Internal worker-only read of a project-scoped encrypted secret. */
export const getProjectSecretValue = async (
  projectId: string,
  name: string,
): Promise<string | null> => {
  const [row] = await db
    .select({
      cipherText: secrets.cipherText,
      iv: secrets.iv,
      authTag: secrets.authTag,
    })
    .from(secrets)
    .where(
      and(
        eq(secrets.projectId, projectId),
        eq(secrets.name, name),
        isNull(secrets.environmentId),
      ),
    )
    .limit(1);

  return readDecryptedSecret(row, name);
};

const getPlatformCredentials = (): AwsDeploymentCredentials => {
  const sessionToken = env.AWS_SESSION_TOKEN?.trim();
  return {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    ...(sessionToken ? { sessionToken } : {}),
  };
};

const resolveCredentialPair = async (
  readSecret: SecretScopeReader,
  names: CredentialNames,
): Promise<AwsDeploymentCredentials> => {
  const [rawAccessKeyId, rawSecretAccessKey, rawSessionToken] = await Promise.all([
    readSecret(names.accessKeyId),
    readSecret(names.secretAccessKey),
    readSecret(names.sessionToken),
  ]);

  const accessKeyId = rawAccessKeyId?.trim() ?? null;
  const secretAccessKey = rawSecretAccessKey?.trim() ?? null;
  const sessionToken = rawSessionToken?.trim() ?? null;

  if ((accessKeyId === null) !== (secretAccessKey === null)) {
    throw new AppError(
      `${names.description} requires both "${names.accessKeyId}" and "${names.secretAccessKey}" secrets`,
      409,
    );
  }

  if (accessKeyId === null && secretAccessKey === null) {
    if (sessionToken !== null) {
      throw new AppError(
        `${names.description} session-token secret requires its access-key and secret-key pair`,
        409,
      );
    }
    // Backward compatibility: a self-hosted operator may intentionally use the
    // platform AWS identity for all destinations. Per-scope keys override it.
    return getPlatformCredentials();
  }

  if (!accessKeyId || !secretAccessKey) {
    throw new AppError(`${names.description} credentials are incomplete`, 409);
  }

  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  };
};


export const resolveEnvironmentS3Credentials = async (
  projectId: string,
  environmentId: string,
): Promise<AwsDeploymentCredentials> =>
  resolveCredentialPair(
    (name) =>
      // Resolve against the exact environment and project, preventing a secret
      // name from another project's environment from being used accidentally.
      getOptionalEnvironmentSecretValue(projectId, environmentId, name),
    {
      accessKeyId: "S3_DEPLOY_AWS_ACCESS_KEY_ID",
      secretAccessKey: "S3_DEPLOY_AWS_SECRET_ACCESS_KEY",
      sessionToken: "S3_DEPLOY_AWS_SESSION_TOKEN",
      description: "S3 deployment",
    },
  );

const getOptionalEnvironmentSecretValue = async (
  projectId: string,
  environmentId: string,
  name: string,
): Promise<string | null> => {
  const [row] = await db
    .select({
      cipherText: secrets.cipherText,
      iv: secrets.iv,
      authTag: secrets.authTag,
    })
    .from(secrets)
    .innerJoin(environments, eq(secrets.environmentId, environments.id))
    .where(
      and(
        eq(environments.id, environmentId),
        eq(environments.projectId, projectId),
        eq(secrets.environmentId, environmentId),
        eq(secrets.name, name),
        isNull(secrets.projectId),
      ),
    )
    .limit(1);

  return readDecryptedSecret(row, name);
};

export const resolveProjectEcrCredentials = async (
  projectId: string,
): Promise<AwsDeploymentCredentials> =>
  resolveCredentialPair(
    (name) => getProjectSecretValue(projectId, name),
    {
      accessKeyId: "ECR_AWS_ACCESS_KEY_ID",
      secretAccessKey: "ECR_AWS_SECRET_ACCESS_KEY",
      sessionToken: "ECR_AWS_SESSION_TOKEN",
      description: "Project ECR",
    },
  );
