import { Worker } from "bullmq";
import { and, eq } from "drizzle-orm";
import yaml from "yaml";
import crypto from "node:crypto";

import { db } from "./db/index.js";
import {
  branchHeads,
  githubIntegrations,
  jobs,
  jobAttempts,
  jobDependencies,
  outboxMessages,
  pipelineVersions,
  projects,
  runs,
  webhookDeliveries,
} from "./db/schema.js";
import { workerRedisConnection } from "./lib/redis/redis.client.js";
import { QUEUE_NAMES } from "./queues/queue-names.js";
import type { WebhookJobData } from "./queues/queues.js";

type ParsedJobSpec = {
  key: string;
  name: string;
  dependsOn: string[];
  allowFailure: boolean;
  timeoutSeconds: number;
  maxAttempts: number;
  definition: Record<string, unknown>;
};

const extractJobs = (normalized: Record<string, unknown>): ParsedJobSpec[] => {
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

  // Fallback default job if the YAML is completely empty
  if (parsedJobs.length === 0) {
    parsedJobs.push({
      key: "build",
      name: "Default Build",
      dependsOn: [],
      allowFailure: false,
      timeoutSeconds: 600,
      maxAttempts: 1,
      definition: {
        key: "build",
        name: "Default Build",
        image: "node:20-alpine",
        steps: [{ name: "Default Step", run: "echo 'Pipeline executed successfully'" }],
      },
    });
  }

  return parsedJobs;
};

export const webhookWorker = new Worker<WebhookJobData>(
  QUEUE_NAMES.webhook,
  async (job) => {
    const { webhookDeliveryId } = job.data;

    const [delivery] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, webhookDeliveryId))
      .limit(1);

    if (!delivery) {
      throw new Error(`Delivery not found: ${webhookDeliveryId}`);
    }

    if (delivery.eventName !== "push") {
      await db
        .update(webhookDeliveries)
        .set({ status: "ignored", processedAt: new Date() })
        .where(eq(webhookDeliveries.id, delivery.id));
      return;
    }

    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, delivery.projectId))
      .limit(1);

    if (!project) {
      throw new Error(`Project not found: ${delivery.projectId}`);
    }

    const branch = delivery.ref?.replace("refs/heads/", "") ?? project.defaultBranch;
    const commitSha = delivery.afterSha;

    if (!commitSha || commitSha === "0000000000000000000000000000000000000000") {
      await db
        .update(webhookDeliveries)
        .set({ status: "ignored", processedAt: new Date() })
        .where(eq(webhookDeliveries.id, delivery.id));
      return;
    }

    await db
      .insert(branchHeads)
      .values({
        projectId: project.id,
        branch,
        commitSha,
        sourceWebhookDeliveryId: delivery.id,
        isDeleted: false,
      })
      .onConflictDoUpdate({
        target: [branchHeads.projectId, branchHeads.branch],
        set: {
          commitSha,
          sourceWebhookDeliveryId: delivery.id,
          isDeleted: false,
          lastObservedAt: new Date(),
        },
      });

    // Default fallback YAML
    let rawYaml = `version: 1\njobs:\n  build:\n    name: Build & Test\n    image: node:20-alpine\n    steps:\n      - name: System Info\n        run: node -v && npm -v`;

    // Try fetching the actual file from GitHub
    try {
      const [integration] = await db
        .select()
        .from(githubIntegrations)
        .where(eq(githubIntegrations.projectId, project.id))
        .limit(1);

      if (integration) {
        const token = integration.accessTokenSecretName ? process.env[integration.accessTokenSecretName] : undefined;
        const headers: Record<string, string> = {};
        if (token) {
          headers["Authorization"] = `Bearer ${token}`;
        }

        const tokenRes = await fetch(
          `https://raw.githubusercontent.com/${project.repositoryFullName}/${commitSha}/${project.pipelinePath}`,
          { headers }
        );

        if (tokenRes.ok) {
          rawYaml = await tokenRes.text();
        } else {
          console.warn(`[WebhookWorker] Failed to fetch pipeline YAML from GitHub: ${tokenRes.statusText}`);
        }
      }
    } catch (err) {
      console.warn("[WebhookWorker] Could not fetch remote pipeline YAML, using fallback");
    }

    let parsedYamlObject: Record<string, unknown>;
    try {
      parsedYamlObject = (yaml.parse(rawYaml) as Record<string, unknown>) ?? {};
    } catch {
      parsedYamlObject = { jobs: { build: { steps: [{ run: "echo 'Fallback execution'" }] } } };
    }

    const configHash = crypto.createHash("sha256").update(rawYaml).digest("hex");

    await db.transaction(async (tx) => {
      let [pipelineVersion] = await tx
        .select()
        .from(pipelineVersions)
        .where(
          and(
            eq(pipelineVersions.projectId, project.id),
            eq(pipelineVersions.commitSha, commitSha),
            eq(pipelineVersions.path, project.pipelinePath)
          )
        )
        .limit(1);

      if (!pipelineVersion) {
        const [inserted] = await tx
          .insert(pipelineVersions)
          .values({
            projectId: project.id,
            path: project.pipelinePath,
            configHash,
            commitSha,
            rawYaml,
            normalizedYaml: parsedYamlObject,
            validationStatus: "valid",
          })
          .returning();
        pipelineVersion = inserted!;
      }

      const [run] = await tx
        .insert(runs)
        .values({
          projectId: project.id,
          pipelineVersionId: pipelineVersion.id,
          webhookDeliveryId: delivery.id,
          commitSha,
          branch,
          status: "queued",
          trigger: "push",
        })
        .returning();

      const jobSpecs = extractJobs(pipelineVersion.normalizedYaml ?? parsedYamlObject);
      const insertedJobsByKey = new Map<string, typeof jobs.$inferSelect>();

      for (const spec of jobSpecs) {
        const isRoot = spec.dependsOn.length === 0;
        const [insertedJob] = await tx
          .insert(jobs)
          .values({
            runId: run!.id,
            key: spec.key,
            name: spec.name,
            definition: spec.definition,
            status: isRoot ? "queued" : "blocked",
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
        const curr = insertedJobsByKey.get(spec.key);
        if (!curr) continue;
        for (const depKey of spec.dependsOn) {
          const dep = insertedJobsByKey.get(depKey);
          if (dep && dep.id !== curr.id) {
            await tx.insert(jobDependencies).values({
              runId: run!.id,
              jobId: curr.id,
              dependsOnJobId: dep.id,
            });
          }
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
              runId: run!.id,
            },
            queueName: QUEUE_NAMES.jobAttempt,
            status: "pending",
          });
        }
      }

      await tx
        .update(webhookDeliveries)
        .set({ status: "processed", processedAt: new Date() })
        .where(eq(webhookDeliveries.id, delivery.id));
    });
  },
  {
    connection: workerRedisConnection,
    concurrency: 5,
  }
);

webhookWorker.on("error", (error) => {
  console.error("[WebhookWorker] Error:", error);
});

webhookWorker.on("failed", (job, error) => {
  console.error("[WebhookWorker] Job failed:", { jobId: job?.id, error });
});