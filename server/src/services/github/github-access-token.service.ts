import { and, eq } from "drizzle-orm";

import { db } from "../../db/index.js";
import { githubIntegrations, secrets } from "../../db/schema.js";
import { AppError } from "../../utils/app.error.js";
import { decryptSecret } from "../secrets/secret.service.js";

/**
 * Resolve the integration's optional project-scoped GitHub token secret.
 * The secret's plaintext is used only in the backend Git process and is never
 * returned through an API response or logged.
 */
export const getGithubAccessTokenForProject = async (
  projectId: string,
): Promise<string | undefined> => {
  const [integration] = await db
    .select({ accessTokenSecretName: githubIntegrations.accessTokenSecretName })
    .from(githubIntegrations)
    .where(and(
      eq(githubIntegrations.projectId, projectId),
      eq(githubIntegrations.enabled, true),
    ))
    .limit(1);

  const secretName = integration?.accessTokenSecretName?.trim();
  if (!secretName) return undefined;

  const [secret] = await db
    .select({
      cipherText: secrets.cipherText,
      iv: secrets.iv,
      authTag: secrets.authTag,
    })
    .from(secrets)
    .where(and(
      eq(secrets.projectId, projectId),
      eq(secrets.name, secretName),
    ))
    .limit(1);

  if (!secret) {
    throw new AppError(`GitHub access token secret "${secretName}" was not found in project secrets`, 400);
  }

  try {
    const token = decryptSecret(secret).trim();
    if (!token) throw new Error("Secret is empty");
    return token;
  } catch {
    throw new AppError(`GitHub access token secret "${secretName}" could not be decrypted`, 500);
  }
};
