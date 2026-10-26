import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  jobs,
  pipelineVersions,
  runs,
  jobDependencies,
} from "../../db/schema.js";
import { AppError } from "../../utils/app.error.js";
import {
  type NormalizedPipeline,
  type NormalizedPipelineJob,
} from "../pipeline/pipeline-normalizer.service.js";
import { buildJobDependencyRows } from "./dependency.service.js";

const isNormalizedPipeline = (
  value: unknown,
): value is NormalizedPipeline => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }

  const jobsValue = (value as { jobs?: unknown }).jobs;

  if (
    jobsValue === null ||
    typeof jobsValue !== "object" ||
    Array.isArray(jobsValue)
  ) {
    return false;
  }

  return true;
};

const validateNormalizedJob = (
  jobKey: string,
  job: NormalizedPipelineJob,
): void => {
  if (
    typeof job.name !== "string" ||
    job.name.trim().length === 0
  ) {
    throw new AppError(
      `Invalid normalized job name for "${jobKey}"`,
      500,
    );
  }

  if (
    !Array.isArray(job.commands) ||
    job.commands.length === 0
  ) {
    throw new AppError(
      `Invalid commands for job "${jobKey}"`,
      500,
    );
  }

  if (!Array.isArray(job.dependsOn)) {
    throw new AppError(
      `Invalid dependencies for job "${jobKey}"`,
      500,
    );
  }

  if (
    !Number.isInteger(job.timeoutSeconds) ||
    job.timeoutSeconds <= 0
  ) {
    throw new AppError(
      `Invalid timeout for job "${jobKey}"`,
      500,
    );
  }

  if (
    !Number.isInteger(job.maxAttempts) ||
    job.maxAttempts < 1 ||
    job.maxAttempts > 5
  ) {
    throw new AppError(
      `Invalid maxAttempts for job "${jobKey}"`,
      500,
    );
  }

  if (typeof job.allowFailure !== "boolean") {
    throw new AppError(
      `Invalid allowFailure for job "${jobKey}"`,
      500,
    );
  }

  // Older immutable pipeline versions may not have output declarations.
  const artifacts: unknown = (job as { artifacts?: unknown }).artifacts;
  if (artifacts !== undefined && !Array.isArray(artifacts)) {
    throw new AppError(`Invalid artifacts for job "${jobKey}"`, 500);
  }
  for (const artifact of (Array.isArray(artifacts) ? artifacts : [])) {
    if (
      artifact === null ||
      typeof artifact !== "object" ||
      Array.isArray(artifact) ||
      typeof (artifact as { name?: unknown }).name !== "string" ||
      typeof (artifact as { path?: unknown }).path !== "string"
    ) {
      throw new AppError(`Invalid artifact declaration for job "${jobKey}"`, 500);
    }
  }

  const containerImage: unknown = (job as { containerImage?: unknown }).containerImage;
  if (containerImage !== undefined) {
    if (
      containerImage === null ||
      typeof containerImage !== "object" ||
      Array.isArray(containerImage)
    ) {
      throw new AppError(`Invalid container image declaration for job "${jobKey}"`, 500);
    }
    const image = containerImage as Record<string, unknown>;
    for (const field of ["name", "registry", "repository", "contextPath", "dockerfilePath"] as const) {
      if (typeof image[field] !== "string" || image[field].trim().length === 0) {
        throw new AppError(`Invalid container image ${field} for job "${jobKey}"`, 500);
      }
    }
    if (image.platform !== undefined && typeof image.platform !== "string") {
      throw new AppError(`Invalid container image platform for job "${jobKey}"`, 500);
    }
  }
};

export type CreateJobsForRunResult = {
  jobs: Array<{
    id: string;
    key: string;
    name: string;
    status: (typeof jobs.$inferSelect)["status"];
  }>;
};

export const createJobsForRun = async (
  runId: string,
): Promise<CreateJobsForRunResult> => {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({
        projectId: runs.projectId,
        pipelineVersionId: runs.pipelineVersionId,
      })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);

    if (!run) {
      throw new AppError("Run not found", 404);
    }

    if (!run.pipelineVersionId) {
      throw new AppError(
        "Run does not have a pipeline version",
        500,
      );
    }

    const [pipelineVersion] = await tx
      .select({
        id: pipelineVersions.id,
        normalizedYaml: pipelineVersions.normalizedYaml,
      })
      .from(pipelineVersions)
      .where(
        and(
          eq(pipelineVersions.id, run.pipelineVersionId),
          eq(pipelineVersions.projectId, run.projectId),
        ),
      )
      .limit(1);

    if (!pipelineVersion) {
      throw new AppError(
        "Pipeline version for run was not found",
        500,
      );
    }

    if (!isNormalizedPipeline(pipelineVersion.normalizedYaml)) {
      throw new AppError(
        "Pipeline version does not contain a valid normalized pipeline",
        500,
      );
    }

    const pipeline = pipelineVersion.normalizedYaml;
    const pipelineEntries = Object.entries(pipeline.jobs);

    if (pipelineEntries.length === 0) {
      throw new AppError(
        "Pipeline contains no jobs",
        400,
      );
    }

    for (const [jobKey, job] of pipelineEntries) {
      validateNormalizedJob(jobKey, job);
    }

    /*
     * Idempotency:
     *
     * If jobs already exist for this run, return them.
     */
    const existingJobs = await tx
      .select({
        id: jobs.id,
        key: jobs.key,
        name: jobs.name,
        status: jobs.status,
      })
      .from(jobs)
      .where(eq(jobs.runId, runId));

    if (existingJobs.length > 0) {
      if (existingJobs.length !== pipelineEntries.length) {
        throw new AppError(
          "Run has an incomplete job set",
          500,
        );
      }

      const existingKeys = new Set(
        existingJobs.map((job) => job.key),
      );

      for (const [jobKey] of pipelineEntries) {
        if (!existingKeys.has(jobKey)) {
          throw new AppError(
            `Run is missing job "${jobKey}"`,
            500,
          );
        }
      }

      const jobIdsByKey = new Map(
        existingJobs.map((job) => [job.key, job.id]),
      );

      const dependencyRows = buildJobDependencyRows(
        runId,
        pipeline,
        jobIdsByKey,
      );

      if (dependencyRows.length > 0) {
        await tx
          .insert(jobDependencies)
          .values(dependencyRows)
          .onConflictDoNothing({
            target: [
              jobDependencies.jobId,
              jobDependencies.dependsOnJobId,
            ],
          });
      }

      return {
        jobs: existingJobs.sort((a, b) =>
          a.key.localeCompare(b.key),
        ),
      };
    }

    const jobValues = pipelineEntries.map(
      ([jobKey, job]) => ({
        runId,
        key: jobKey,
        name: job.name,
        definition: {
          name: job.name,
          commands: [...job.commands],
          dependsOn: [...job.dependsOn],
          timeoutSeconds: job.timeoutSeconds,
          maxAttempts: job.maxAttempts,
          allowFailure: job.allowFailure,
          // Default to an empty array for historical normalized pipelines.
          artifacts: [...(job.artifacts ?? [])].map(({ name, path }) => ({ name, path })),
          ...(job.containerImage === undefined
            ? {}
            : {
                containerImage: {
                  name: job.containerImage.name,
                  registry: job.containerImage.registry,
                  repository: job.containerImage.repository,
                  contextPath: job.containerImage.contextPath,
                  dockerfilePath: job.containerImage.dockerfilePath,
                  ...(job.containerImage.platform === undefined
                    ? {}
                    : { platform: job.containerImage.platform }),
                },
              }),
        },
        status: "blocked" as const,
        allowFailure: job.allowFailure,
        maxAttempts: job.maxAttempts,
        timeoutSeconds: job.timeoutSeconds,
      }),
    );

    const insertedJobs = await tx
      .insert(jobs)
      .values(jobValues)
      .onConflictDoNothing({
        target: [jobs.runId, jobs.key],
      })
      .returning({
        id: jobs.id,
        key: jobs.key,
        name: jobs.name,
        status: jobs.status,
      });

    /*
     * Normally every row is inserted.
     *
     * If another transaction won the unique constraint, read the
     * complete job set again.
     */
    const createdJobs =
      insertedJobs.length === pipelineEntries.length
        ? insertedJobs
        : await tx
            .select({
              id: jobs.id,
              key: jobs.key,
              name: jobs.name,
              status: jobs.status,
            })
            .from(jobs)
            .where(eq(jobs.runId, runId));

    if (createdJobs.length !== pipelineEntries.length) {
      throw new AppError(
        "Could not create the complete job set",
        500,
      );
    }

    const jobIdsByKey = new Map(
      createdJobs.map((job) => [job.key, job.id]),
    );

    const dependencyRows = buildJobDependencyRows(
      runId,
      pipeline,
      jobIdsByKey,
    );

    if (dependencyRows.length > 0) {
      await tx
        .insert(jobDependencies)
        .values(dependencyRows)
        .onConflictDoNothing({
          target: [
            jobDependencies.jobId,
            jobDependencies.dependsOnJobId,
          ],
        });
    }

    return {
      jobs: createdJobs.sort((a, b) =>
        a.key.localeCompare(b.key),
      ),
    };
  });
};


