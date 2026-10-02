import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { githubIntegrations, projects } from "../../db/schema.js";
import { AppError } from "../../utils/app.error.js";
import type {
  CreateGithubIntegration,
  UpdateGithubIntegration,
} from "../../validators/github/github-integration.validator.js";
import { encrypt } from "../../utils/crypto.util.js";

type GithubIntegrationRow = typeof githubIntegrations.$inferSelect;

export type PublicGithubIntegration = Omit<
  GithubIntegrationRow,
  | "webhookSecretCiphertext"
  | "webhookSecretIv"
  | "webhookSecretAuthTag"
  | "webhookSecretVersion"
>;


const findProjectForUser = async (projectId: string, userId: string) => {
  const [project] = await db
    .select({
      id: projects.id,
      repositoryFullName: projects.repositoryFullName,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.createdById, userId)))
    .limit(1);

  return project;
};

const findIntegrationByProjectId = async (projectId: string) => {
  const [integration] = await db
    .select()
    .from(githubIntegrations)
    .where(eq(githubIntegrations.projectId, projectId))
    .limit(1);

  return integration;
};

const toPublicIntegration = (integration: GithubIntegrationRow): PublicGithubIntegration => {
  const {
    webhookSecretCiphertext,
    webhookSecretIv,
    webhookSecretAuthTag,
    webhookSecretVersion,
    ...publicIntegration
  } = integration;

  void webhookSecretCiphertext;
  void webhookSecretIv;
  void webhookSecretAuthTag;
  void webhookSecretVersion;

  return publicIntegration;
};

const isUniqueViolation = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown };
  return candidate.code === "23505";
};

export const createGithubIntegration = async (
  projectId: string,
  userId: string,
  data: CreateGithubIntegration,
): Promise<PublicGithubIntegration> => {
  const project = await findProjectForUser(projectId, userId);

  if (!project) {
    throw new AppError("Project not found", 404);
  }

  const existingIntegration = await findIntegrationByProjectId(projectId);

  if (existingIntegration) {
    throw new AppError("GitHub integration already exists for this project",409);
  }

  const encrypted = encrypt(data.webhookSecret);

  try {
    const [integration] = await db
      .insert(githubIntegrations)
      .values({
      projectId: project.id,
      repositoryFullName: project.repositoryFullName,
      webhookSecretCiphertext: encrypted.ciphertext,
      webhookSecretIv: encrypted.iv,
      webhookSecretAuthTag: encrypted.authTag,
      webhookSecretVersion: 1,
      accessTokenSecretName: data.accessTokenSecretName,
      enabled: data.enabled,
    }).returning();

    if (!integration) {
      throw new AppError("Failed to create GitHub integration", 500);
    }

    return toPublicIntegration(integration);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError("GitHub integration already exists for this project",409);
    }
    throw error;
  }
};

export const getGithubIntegration = async (
  projectId: string,
  userId: string,
): Promise<PublicGithubIntegration> => {
  const project = await findProjectForUser(projectId, userId);

  if (!project) {
    throw new AppError("Project not found", 404);
  }

  const integration = await findIntegrationByProjectId(projectId);

  if (!integration) {
    throw new AppError("GitHub integration not found", 404);
  }

  return toPublicIntegration(integration);
};

export const updateGithubIntegration = async (
  projectId: string,
  userId: string,
  data: UpdateGithubIntegration,
): Promise<PublicGithubIntegration> => {
  const project = await findProjectForUser(projectId, userId);

  if (!project) throw new AppError("Project not found", 404);

  const existingIntegration = await findIntegrationByProjectId(projectId);

  if (!existingIntegration) throw new AppError("GitHub integration not found", 404);
  
  const updates: Partial<typeof githubIntegrations.$inferInsert> = {};

  if (data.webhookSecret !== undefined) {
    const encrypted = encrypt(data.webhookSecret);
    updates.webhookSecretCiphertext = encrypted.ciphertext;
    updates.webhookSecretIv = encrypted.iv;
    updates.webhookSecretAuthTag = encrypted.authTag;
    updates.webhookSecretVersion = 1;
  }

  if (data.accessTokenSecretName !== undefined) {
    updates.accessTokenSecretName = data.accessTokenSecretName;
  }

  if (data.enabled !== undefined) {
    updates.enabled = data.enabled;
  }

  if (existingIntegration.repositoryFullName !== project.repositoryFullName) {
    updates.repositoryFullName = project.repositoryFullName;
  }

  if (Object.keys(updates).length === 0) {
    return toPublicIntegration(existingIntegration);
  }

  const [updatedIntegration] = await db
    .update(githubIntegrations)
    .set(updates)
    .where(eq(githubIntegrations.id, existingIntegration.id))
    .returning();

  if (!updatedIntegration) {
    throw new AppError("Failed to update GitHub integration", 500);
  }

  return toPublicIntegration(updatedIntegration);
};