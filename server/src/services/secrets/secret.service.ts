import { and, asc, eq } from "drizzle-orm";
import type { SQL }from "drizzle-orm"
import { db } from "../../db/index.js";
import { environments, projects, secrets } from "../../db/schema.js";
import { AppError } from "../../utils/app.error.js";
import { decrypt, encrypt } from "../../utils/crypto.util.js";

type SecretRow = typeof secrets.$inferSelect;

export type SecretScope =
  | {
      kind: "project";
      projectId: string;
    }
  | {
      kind: "environment";
      projectId: string;
      environmentId: string;
    };

type ResolvedScope = {
  where: SQL;
  owner: Pick<SecretRow,"projectId" | "environmentId">;
};
 

// Only metadata is returned by the normal Secrets API.
const publicColumns = {
  id: secrets.id,
  name: secrets.name,
  projectId: secrets.projectId,
  environmentId: secrets.environmentId,
  createdAt: secrets.createdAt,
  updatedAt: secrets.updatedAt,
};

export type PublicSecret = Pick<SecretRow, keyof typeof publicColumns>;

const MAX_SECRET_VALUE_BYTES = 64 * 1024;

/* -------------------------------------------------------------------------- */
/* Database error helpers                                                     */
/* -------------------------------------------------------------------------- */

/**
 * PostgreSQL errors can be wrapped inside `cause`.
 *
 * Walk the cause chain safely and look for the PostgreSQL
 * unique-violation error code.
 */
const isUniqueViolation = (error: unknown ): boolean => {
  const seen = new Set<object>();
  let current: unknown = error;
  while ( current !== null && typeof current === "object") {
    if (seen.has(current)) return false;
    seen.add(current);

    if ("code" in current) {
      const code = ( current as { code?: unknown}).code;
      if (code === "23505") {
        return true;
      }
    }
    if (!("cause" in current)) {
      return false;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};



// DeployBench limits every secret value to 64 KiB.
const assertSecretValueSize = ( value: string ): void => {
  const sizeInBytes =Buffer.byteLength(value,"utf8");
  if  (sizeInBytes > MAX_SECRET_VALUE_BYTES ) {
    throw new AppError("Secret value cannot exceed 64 KiB",400);
  }
};

const encryptValue = ( value: string ) => {
  assertSecretValueSize(value);
  const { ciphertext, iv, authTag } = encrypt(value);
  return { cipherText: ciphertext,iv,authTag };
};


 // Trusted internal use only.
 // plaintext result must never be returned by the normal Secrets REST API.
export const decryptSecret = ({
  cipherText,
  iv,
  authTag,
}: Pick<
  SecretRow,
  "cipherText" | "iv" | "authTag"
>): string => {
  return decrypt({
    ciphertext: cipherText,
    iv,
    authTag,
  });
};

/* -------------------------------------------------------------------------- */
/* Scope resolution + authorization                                           */
/* -------------------------------------------------------------------------- */

/**
 * Verifies that the authenticated user owns the requested scope.
 *
 * Project scope:
 *   projectId set
 *   environmentId NULL
 *
 * Environment scope:
 *   projectId NULL
 *   environmentId set
 *
 * The database CHECK constraint enforces this invariant.
 */
const resolveScope = async ( userId: string, scope: SecretScope ): Promise<ResolvedScope> => {
 // environment scope
  if (scope.kind === "environment") {
    const [environment] =
      await db
        .select({ id: environments.id})
        .from(environments)
        .innerJoin(projects,eq(environments.projectId,projects.id))
        .where(
          and(
            eq(environments.id,scope.environmentId),
            eq(environments.projectId,scope.projectId),
            eq(projects.createdById,userId),
          ),
        ).limit(1);
    if (!environment) throw new AppError("Environment not found",404);

    return {
      where: eq(
        secrets.environmentId,
        scope.environmentId,
      ),
      owner: {
        projectId: null,
        environmentId:
          scope.environmentId,
      },
    };
  }
  // project scope
  const [project] =
    await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id,scope.projectId),
          eq(projects.createdById,userId),
        ),
      ).limit(1);
  if (!project) throw new AppError("Project not found",404);

  return {
    where: eq(
      secrets.projectId,
      scope.projectId,
    ),
    owner: {
      projectId:
        scope.projectId,
      environmentId: null,
    },
  };
};


export const createSecret = async (
  userId: string,
  scope: SecretScope,
  input: {
    name: string;
    value: string;
  },
): Promise<PublicSecret> => {
  const { owner } =
    await resolveScope(
      userId,
      scope,
    );

  /*
   * Zod has already validated the request shape/name.
   *
   * encryptValue additionally protects the service from
   * arbitrarily large secret values.
   */
  const encrypted = encryptValue(input.value);

  try {
    const [secret] =
      await db
        .insert(secrets)
        .values({
          name: input.name,
          ...owner,
          ...encrypted,
        })
        .returning(
          publicColumns,
        );

    if (!secret) throw new AppError("Failed to create secret",500);
    return secret;

  } catch (error) {
    if (error instanceof AppError) throw error;

    if (isUniqueViolation(error)) {
      throw new AppError("A secret with this name already exists in this scope",409);
    }

    throw error;
  }
};

export const listSecrets = async (
  userId: string,
  scope: SecretScope,
): Promise<PublicSecret[]> => {
  const { where } = await resolveScope(userId,scope);
  return db
    .select(publicColumns)
    .from(secrets)
    .where(where)
    .orderBy(asc(secrets.name));
};

export const getSecret = async (
  userId: string,
  scope: SecretScope,
  secretId: string,
): Promise<PublicSecret> => {
  const { where } = await resolveScope(userId,scope);

  const [secret] = await db
      .select(publicColumns)
      .from(secrets)
      .where(and(eq(secrets.id,secretId),where)).limit(1);

  if (!secret) throw new AppError("Secret not found",404);

  return secret;
};

export const updateSecret = async (
  userId: string,
  scope: SecretScope,
  secretId: string,
  input: {
    name?: string | undefined;
    value?: string | undefined;
  },
): Promise<PublicSecret> => {
  const { where } = await resolveScope(userId,scope);
  /*
   * Zod already guarantees that at least one
   * field is present.
   *
   * Name:
   *   only updates the name.
   *
   * Value:
   *   encrypts a completely new value and therefore
   *   generates a new ciphertext, IV and auth tag.
   */
  const patch = {
    updatedAt: new Date(),
    ...(input.name !== undefined ? { name: input.name }: {}),
    ...(input.value !== undefined ? encryptValue(input.value) : {}),
  };

  try {
    const [secret] =await db
        .update(secrets)
        .set(patch)
        .where(and(eq(secrets.id,secretId),where))
        .returning(publicColumns);

    if (!secret) throw new AppError("Secret not found",404);
  
    return secret;
  } catch (error) {
    if (error instanceof AppError) throw error;

    if (isUniqueViolation(error)) {
      throw new AppError("A secret with this name already exists in this scope",409);
    }

    throw error;
  }
};

export const deleteSecret = async (
  userId: string,
  scope: SecretScope,
  secretId: string,
): Promise<{
  secretId: string;
  name: string;
}> => {
  const { where } = await resolveScope(userId,scope);

  const [deleted] = await db
      .delete(secrets)
      .where(and(eq(secrets.id,secretId,),where))
      .returning({
        secretId:
        secrets.id,
        name: secrets.name,
      });

  if (!deleted) throw new AppError("Secret not found",404);
  
  return deleted;
};