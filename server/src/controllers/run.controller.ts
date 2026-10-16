import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import yaml from "yaml";

import { db } from "../db/index.js";
import {
  artifacts,
  branchHeads,
  containerImages,
  jobAttempts,
  jobDependencies,
  jobs,
  outboxMessages,
  pipelineVersions,
  projects,
  runs,
} from "../db/schema.js";
import { QUEUE_NAMES } from "../queues/queue-names.js";
import { AppError } from "../utils/app.error.js";
import type {
  ProjectRunsParams,
  RunIdParams,
  TriggerManualRunInput,
} from "../validators/run.validator.js";

const DEFAULT_PIPELINE_YAML = `version: 1
jobs:
  build:
    name: Build & Test
    image: node:20-alpine
    timeoutSeconds: 600
    maxAttempts: 1
    steps:
      - name: Check environment
        run: node -v && npm -v
      - name: Run build check
        run: echo "Build succeeded"
`;

type ParsedJobSpec = {
  key: string;
  name: string;
  dependsOn: string[];
  allowFailure: boolean;
  timeoutSeconds: number;
  maxAttempts: number;
  definition: Record<string, unknown>;
};

const extractJobsFromNormalizedYaml = (
  normalized: Record<string, unknown>,
): ParsedJobSpec[] => {
  const rawJobs = normalized.jobs;
  const parsedJobs: ParsedJobSpec[] = [];

  if (Array.isArray(rawJobs)) {
    for (const item of rawJobs) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const record = item as Record<string, unknown>;
        const key = String(record.key ?? record.id ?? record.name ?? "").trim();
        if (!key) continue;
        const name = String(record.name ?? key).trim();
        const dependsOn = Array.isArray(record.dependsOn)
          ? record.dependsOn.map((d) => String(d))
          : Array.isArray(record.needs)
            ? record.needs.map((d) => String(d))
            : [];
        parsedJobs.push({
          key,
          name,
          dependsOn,
          allowFailure: Boolean(record.allowFailure ?? false),
          timeoutSeconds: Number(record.timeoutSeconds ?? 3600),
          maxAttempts: Math.min(5, Math.max(1, Number(record.maxAttempts ?? 1))),
          definition: record,
        });
      }
    }
  } else if (rawJobs && typeof rawJobs === "object") {
    for (const [key, value] of Object.entries(rawJobs as Record<string, unknown>)) {
      const record =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      const name = String(record.name ?? key).trim();
      const dependsOn = Array.isArray(record.dependsOn)
        ? record.dependsOn.map((d) => String(d))
        : Array.isArray(record.needs)
          ? record.needs.map((d) => String(d))
          : [];
      parsedJobs.push({
        key,
        name,
        dependsOn,
        allowFailure: Boolean(record.allowFailure ?? false),
        timeoutSeconds: Number(record.timeoutSeconds ?? 3600),
        maxAttempts: Math.min(5, Math.max(1, Number(record.maxAttempts ?? 1))),
        definition: { key, ...record },
      });
    }
  }

  if (parsedJobs.length === 0) {
    parsedJobs.push({
      key: "build",
      name: "Build & Test",
      dependsOn: [],
      allowFailure: false,
      timeoutSeconds: 600,
      maxAttempts: 1,
      definition: {
        key: "build",
        name: "Build & Test",
        image: "node:20-alpine",
        steps: [{ name: "Build", run: "echo 'Running default pipeline job'" }],
      },
    });
  }

  return parsedJobs;
};

const verifyProjectAccess = async (projectId: string, userId: string) => {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.createdById, userId)))
    .limit(1);

  if (!project) {
    throw new AppError("Project not found", 404);
  }

  return project;
};

const verifyRunAccess = async (runId: string, userId: string) => {
  const [row] = await db
    .select({
      run: runs,
      project: projects,
    })
    .from(runs)
    .innerJoin(projects, eq(runs.projectId, projects.id))
    .where(and(eq(runs.id, runId), eq(projects.createdById, userId)))
    .limit(1);

  if (!row) {
    throw new AppError("Run not found", 404);
  }

  return row;
};

export const listProjectRuns = async (
  req: Request<ProjectRunsParams>,
  res: Response,
  next: NextFunction,
) => {
  try {
    await verifyProjectAccess(req.params.projectId, req.user!.id);

    const branchFilter =
      typeof req.query.branch === "string" && req.query.branch.trim().length > 0
        ? req.query.branch.trim()
        : undefined;

    const statusFilter =
      typeof req.query.status === "string" && req.query.status.trim().length > 0
        ? (req.query.status.trim() as typeof runs.$inferSelect.status)
        : undefined;

    const conditions = [eq(runs.projectId, req.params.projectId)];
    if (branchFilter) {
      conditions.push(eq(runs.branch, branchFilter));
    }
    if (statusFilter) {
      conditions.push(eq(runs.status, statusFilter));
    }

    const projectRuns = await db
      .select()
      .from(runs)
      .where(and(...conditions))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(50);

    return res.status(200).json({
      success: true,
      message: "Runs fetched successfully",
      data: {
        runs: projectRuns,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const triggerManualRun = async (
  req: Request<ProjectRunsParams, unknown, TriggerManualRunInput>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const project = await verifyProjectAccess(req.params.projectId, req.user!.id);

    const branch = req.body.branch?.trim() || project.defaultBranch;

    let commitSha = req.body.commitSha?.trim();
    if (!commitSha) {
      const [branchHead] = await db
        .select()
        .from(branchHeads)
        .where(
          and(
            eq(branchHeads.projectId, project.id),
            eq(branchHeads.branch, branch),
          ),
        )
        .limit(1);

      commitSha =
        branchHead?.commitSha ??
        crypto.createHash("sha1").update(`${project.id}:${branch}:${Date.now()}`).digest("hex");
    }

    const rawYaml = req.body.rawYaml?.trim() || DEFAULT_PIPELINE_YAML;
    let parsedYamlObject: Record<string, unknown>;
    try {
      const parsed = yaml.parse(rawYaml);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Pipeline YAML must evaluate to an object");
      }
      parsedYamlObject = parsed as Record<string, unknown>;
    } catch (err) {
      throw new AppError(
        err instanceof Error ? `Invalid pipeline YAML: ${err.message}` : "Invalid pipeline YAML",
        400,
      );
    }

    const configHash = crypto.createHash("sha256").update(rawYaml).digest("hex");

    const createdRun = await db.transaction(async (tx) => {
      const [existingVersion] = await tx
        .select()
        .from(pipelineVersions)
        .where(
          and(
            eq(pipelineVersions.projectId, project.id),
            eq(pipelineVersions.commitSha, commitSha),
            eq(pipelineVersions.path, project.pipelinePath),
          ),
        )
        .limit(1);

      let pipelineVersion = existingVersion;

      if (!pipelineVersion) {
        const [insertedVersion] = await tx
          .insert(pipelineVersions)
          .values({
            projectId: project.id,
            path: project.pipelinePath,
            configHash,
            commitSha,
            rawYaml,
            normalizedYaml: parsedYamlObject,
            validationStatus: "valid",
            validationError: null,
          })
          .returning();

        if (!insertedVersion) {
          throw new AppError("Failed to create pipeline version", 500);
        }
        pipelineVersion = insertedVersion;
      } else if (pipelineVersion.validationStatus !== "valid" || !pipelineVersion.normalizedYaml) {
        throw new AppError(
          `Pipeline version for commit ${commitSha} is invalid: ${pipelineVersion.validationError ?? "unknown error"}`,
          409,
        );
      }

      const [run] = await tx
        .insert(runs)
        .values({
          projectId: project.id,
          pipelineVersionId: pipelineVersion.id,
          commitSha,
          branch,
          status: "queued",
          trigger: "manual",
        })
        .returning();

      if (!run) {
        throw new AppError("Failed to create run", 500);
      }

      const jobSpecs = extractJobsFromNormalizedYaml(
        pipelineVersion.normalizedYaml ?? parsedYamlObject,
      );

      const insertedJobsByKey = new Map<string, typeof jobs.$inferSelect>();

      for (const spec of jobSpecs) {
        const isRootJob = spec.dependsOn.length === 0;
        const [insertedJob] = await tx
          .insert(jobs)
          .values({
            runId: run.id,
            key: spec.key,
            name: spec.name,
            definition: spec.definition,
            status: isRootJob ? "queued" : "blocked",
            allowFailure: spec.allowFailure,
            timeoutSeconds: spec.timeoutSeconds,
            maxAttempts: spec.maxAttempts,
          })
          .returning();

        if (!insertedJob) {
          throw new AppError(`Failed to create job ${spec.key}`, 500);
        }

        insertedJobsByKey.set(spec.key, insertedJob);
      }

      for (const spec of jobSpecs) {
        const currentJob = insertedJobsByKey.get(spec.key);
        if (!currentJob) continue;

        for (const depKey of spec.dependsOn) {
          const depJob = insertedJobsByKey.get(depKey);
          if (!depJob || depJob.id === currentJob.id) continue;

          await tx.insert(jobDependencies).values({
            runId: run.id,
            jobId: currentJob.id,
            dependsOnJobId: depJob.id,
          });
        }
      }

      for (const spec of jobSpecs) {
        if (spec.dependsOn.length > 0) continue;
        const rootJob = insertedJobsByKey.get(spec.key);
        if (!rootJob) continue;

        const [attempt] = await tx
          .insert(jobAttempts)
          .values({
            jobId: rootJob.id,
            attemptNumber: 1,
            status: "queued",
            queueName: QUEUE_NAMES.jobAttempt,
          })
          .returning();

        if (attempt) {
          await tx.insert(outboxMessages).values({
            messageType: "job-attempt.queued",
            aggregateType: "job_attempt",
            aggregateId: attempt.id,
            dedupeKey: `job-attempt.queued:${attempt.id}`,
            payload: {
              jobAttemptId: attempt.id,
              jobId: rootJob.id,
              runId: run.id,
            },
            queueName: QUEUE_NAMES.jobAttempt,
            status: "pending",
          });
        }
      }

      return run;
    });

    return res.status(201).json({
      success: true,
      message: "Run triggered successfully",
      data: {
        run: createdRun,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getRunDetails = async (
  req: Request<RunIdParams>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { run } = await verifyRunAccess(req.params.runId, req.user!.id);

    const [pipelineVersion] = await db
      .select()
      .from(pipelineVersions)
      .where(eq(pipelineVersions.id, run.pipelineVersionId))
      .limit(1);

    const runJobs = await db
      .select()
      .from(jobs)
      .where(eq(jobs.runId, run.id))
      .orderBy(asc(jobs.createdAt), asc(jobs.key));

    const dependencies = await db
      .select()
      .from(jobDependencies)
      .where(eq(jobDependencies.runId, run.id));

    const jobIds = runJobs.map((j) => j.id);
    const attempts =
      jobIds.length > 0
        ? await db
            .select()
            .from(jobAttempts)
            .where(inArray(jobAttempts.jobId, jobIds))
            .orderBy(desc(jobAttempts.attemptNumber))
        : [];

    const runArtifacts = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.runId, run.id))
      .orderBy(desc(artifacts.createdAt));

    const runImages = await db
      .select()
      .from(containerImages)
      .where(eq(containerImages.runId, run.id))
      .orderBy(desc(containerImages.createdAt));

    return res.status(200).json({
      success: true,
      message: "Run details fetched successfully",
      data: {
        run,
        pipelineVersion: pipelineVersion ?? null,
        jobs: runJobs,
        dependencies,
        attempts,
        artifacts: runArtifacts,
        containerImages: runImages,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const cancelRun = async (
  req: Request<RunIdParams>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { run } = await verifyRunAccess(req.params.runId, req.user!.id);

    if (
      run.status === "success" ||
      run.status === "failed" ||
      run.status === "cancelled" ||
      run.status === "superseded"
    ) {
      throw new AppError(`Run cannot be cancelled while in '${run.status}' status`, 409);
    }

    const now = new Date();

    const updatedRun = await db.transaction(async (tx) => {
      const [cancelled] = await tx
        .update(runs)
        .set({
          status: "cancelled",
          cancelRequestedAt: now,
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(runs.id, run.id))
        .returning();

      const activeJobs = await tx
        .update(jobs)
        .set({
          status: "cancelled",
          finishedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(jobs.runId, run.id),
            inArray(jobs.status, ["blocked", "queued", "running"]),
          ),
        )
        .returning({ id: jobs.id });

      const activeJobIds = activeJobs.map((j) => j.id);
      if (activeJobIds.length > 0) {
        await tx
          .update(jobAttempts)
          .set({
            status: "cancelled",
            finishedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              inArray(jobAttempts.jobId, activeJobIds),
              inArray(jobAttempts.status, ["queued", "running"]),
            ),
          );
      }

      return cancelled ?? run;
    });

    return res.status(200).json({
      success: true,
      message: "Run cancelled successfully",
      data: {
        run: updatedRun,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const retryRun = async (
  req: Request<RunIdParams>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { run } = await verifyRunAccess(req.params.runId, req.user!.id);

    const [pipelineVersion] = await db
      .select()
      .from(pipelineVersions)
      .where(eq(pipelineVersions.id, run.pipelineVersionId))
      .limit(1);

    if (!pipelineVersion || !pipelineVersion.normalizedYaml) {
      throw new AppError("Pipeline version not found or invalid for retry", 409);
    }

    const retriedRun = await db.transaction(async (tx) => {
      const [newRun] = await tx
        .insert(runs)
        .values({
          projectId: run.projectId,
          pipelineVersionId: run.pipelineVersionId,
          commitSha: run.commitSha,
          branch: run.branch,
          status: "queued",
          trigger: "retry",
        })
        .returning();

      if (!newRun) {
        throw new AppError("Failed to create retry run", 500);
      }

      const jobSpecs = extractJobsFromNormalizedYaml(pipelineVersion.normalizedYaml!);
      const insertedJobsByKey = new Map<string, typeof jobs.$inferSelect>();

      for (const spec of jobSpecs) {
        const isRootJob = spec.dependsOn.length === 0;
        const [insertedJob] = await tx
          .insert(jobs)
          .values({
            runId: newRun.id,
            key: spec.key,
            name: spec.name,
            definition: spec.definition,
            status: isRootJob ? "queued" : "blocked",
            allowFailure: spec.allowFailure,
            timeoutSeconds: spec.timeoutSeconds,
            maxAttempts: spec.maxAttempts,
          })
          .returning();

        if (insertedJob) {
          insertedJobsByKey.set(spec.key, insertedJob);
        }
      }

      for (const spec of jobSpecs) {
        const currentJob = insertedJobsByKey.get(spec.key);
        if (!currentJob) continue;

        for (const depKey of spec.dependsOn) {
          const depJob = insertedJobsByKey.get(depKey);
          if (!depJob || depJob.id === currentJob.id) continue;

          await tx.insert(jobDependencies).values({
            runId: newRun.id,
            jobId: currentJob.id,
            dependsOnJobId: depJob.id,
          });
        }
      }

      for (const spec of jobSpecs) {
        if (spec.dependsOn.length > 0) continue;
        const rootJob = insertedJobsByKey.get(spec.key);
        if (!rootJob) continue;

        const [attempt] = await tx
          .insert(jobAttempts)
          .values({
            jobId: rootJob.id,
            attemptNumber: 1,
            status: "queued",
            queueName: QUEUE_NAMES.jobAttempt,
          })
          .returning();

        if (attempt) {
          await tx.insert(outboxMessages).values({
            messageType: "job-attempt.queued",
            aggregateType: "job_attempt",
            aggregateId: attempt.id,
            dedupeKey: `job-attempt.queued:${attempt.id}`,
            payload: {
              jobAttemptId: attempt.id,
              jobId: rootJob.id,
              runId: newRun.id,
            },
            queueName: QUEUE_NAMES.jobAttempt,
            status: "pending",
          });
        }
      }

      return newRun;
    });

    return res.status(201).json({
      success: true,
      message: "Run retry queued successfully",
      data: {
        run: retriedRun,
      },
    });
  } catch (error) {
    next(error);
  }
};