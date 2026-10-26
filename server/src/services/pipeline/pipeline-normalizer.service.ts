import { createHash } from "node:crypto";
import type { ValidatedPipeline } from "../../validators/pipeline.validator.js";

export type NormalizedArtifactDeclaration = {
  name: string;
  path: string;
};

export type NormalizedContainerImage = {
  name: string;
  registry: string;
  repository: string;
  contextPath: string;
  dockerfilePath: string;
  platform?: string;
};

export type NormalizedPipelineJob = {
  name: string;
  commands: string[];
  dependsOn: string[];
  timeoutSeconds: number;
  maxAttempts: number;
  allowFailure: boolean;
  artifacts: NormalizedArtifactDeclaration[];
  containerImage?: NormalizedContainerImage;
};

export type NormalizedPipeline = {
  jobs: Record<string, NormalizedPipelineJob>;
};

export type NormalizedPipelineResult = {
  normalizedPipeline: NormalizedPipeline;
  configHash: string;
};

const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const normalizePipeline = (pipeline: ValidatedPipeline): NormalizedPipelineResult => {
  const sortedJobs: [string, NormalizedPipelineJob][] = Object.entries(pipeline.jobs)
    .sort(([a], [b]) => compareKeys(a, b))
    .map(([jobKey, job]) => {
      const image = job.containerImage;
      const normalizedJob: NormalizedPipelineJob = {
        name: job.name ?? jobKey,
        // Not trimmed: trimming would change executable input.
        commands: [...job.commands],
        // Dependency order has no meaning; sort for a stable hash.
        dependsOn: [...job.dependsOn].sort(compareKeys),
        // Defaults are materialized so equivalent YAML normalizes identically.
        timeoutSeconds: job.timeoutSeconds,
        maxAttempts: job.maxAttempts,
        allowFailure: job.allowFailure,
        artifacts: [...(job.artifacts ?? [])]
          .map(({ name, path }) => ({ name, path }))
          .sort((a, b) => compareKeys(a.name, b.name) || compareKeys(a.path, b.path)),
        ...(image === undefined
          ? {}
          : {
              containerImage: {
                name: image.name.trim(),
                registry: image.registry.trim().toLowerCase(),
                repository: image.repository.trim().toLowerCase(),
                contextPath: image.contextPath,
                dockerfilePath: image.dockerfilePath,
                ...(image.platform === undefined ? {} : { platform: image.platform }),
              },
            }),
      };

      return [jobKey, normalizedJob];
    });

  const normalizedPipeline: NormalizedPipeline = { jobs: Object.fromEntries(sortedJobs) };

  // Hash a sorted array, not the object: JS objects reorder integer-like keys
  // ("1", "2") and Postgres jsonb reorders keys again, so object order is not canonical.
  const configHash = createHash("sha256")
    .update(JSON.stringify(sortedJobs), "utf8")
    .digest("hex");

  return { normalizedPipeline, configHash };
};
