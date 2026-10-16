import { db } from "../../db/index.js";
import { projects } from "../../db/schema.js";
import { and, desc, eq, sql } from "drizzle-orm";
import type {
  CreateProject,
  UpdateProject,
} from "../../validators/project.validator.js";
import { AppError } from "../../utils/app.error.js";

const generateSlug = (name: string): string => {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

  return slug || "project";
};

const generateUniqueSlug = async (name: string): Promise<string> => {
  const baseSlug = generateSlug(name);

  const [existing] = await db
    .select({
      id: projects.id,
    })
    .from(projects)
    .where(eq(projects.slug, baseSlug))
    .limit(1);

  if (!existing) {
    return baseSlug;
  }

  let count = 2;

  while (true) {
    const suffix = `-${count}`;
    const maxBaseLength = 120 - suffix.length;

    const candidate = `${baseSlug.slice(0, maxBaseLength)}${suffix}`;

    const [slugExists] = await db.select({id: projects.id})
      .from(projects)
      .where(eq(projects.slug, candidate))
      .limit(1);

    if (!slugExists) {
      return candidate;
    }

    count++;
  }
};

export const createProject = async (data: CreateProject, userId: string) => {
  const [existingProject] = await db.select({id: projects.id})
    .from(projects)
    .where(
      sql`lower(${projects.repositoryFullName}) = lower(${data.repositoryFullName})`,
    )
    .limit(1);

  if (existingProject) {
    throw new AppError("A project with this repository already exists",409);
  }

  const slug = await generateUniqueSlug(data.name);

  const [project] = await db
    .insert(projects)
    .values({
      name: data.name,
      slug,
      repositoryUrl: data.repositoryUrl,
      repositoryFullName: data.repositoryFullName,
      defaultBranch: data.defaultBranch,
      pipelinePath: data.pipelinePath,
      createdById: userId,
    }).returning();

  return project;
};

export const getProjects = async (userId: string) => {
  const projectList = await db
    .select()
    .from(projects)
    .where(eq(projects.createdById, userId))
    .orderBy(desc(projects.createdAt));

  return projectList;
};

export const getProjectById = async (projectId: string, userId: string) => {
  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.createdById, userId),
      ),
    )
    .limit(1);

  if (!project) {
    throw new AppError("Project not found", 404);
  }

  return project;
};

export const updateProject = async (projectId: string, userId: string,data: UpdateProject) => {
  const existingProject = await getProjectById(
    projectId,
    userId,
  );

  const [updatedProject] = await db
    .update(projects)
    .set({
      name: data.name ?? existingProject.name,
      defaultBranch:
        data.defaultBranch ?? existingProject.defaultBranch,
      pipelinePath:
        data.pipelinePath ?? existingProject.pipelinePath,
    })
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.createdById, userId),
      ),
    )
    .returning();

  return updatedProject;
};

export const deleteProject = async (projectId: string,userId: string) => {
  const [deletedProject] = await db
    .delete(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.createdById, userId),
      ),
    )
    .returning();

  if (!deletedProject) {
    throw new AppError("Project not found", 404);
  }

  return deletedProject;
};