import { AppError } from "../../utils/app.error.js";
import type {
  NormalizedPipeline,
} from "../pipeline/pipeline-normalizer.service.js";

export type JobKeyToId = ReadonlyMap<string, string>;

export type JobDependencyInsert = {
  runId: string;
  jobId: string;
  dependsOnJobId: string;
};

/**
 * Converts the normalized pipeline dependency definitions into
 * job_dependencies rows.
 *
 * The validator already rejects self/unknown/duplicate dependencies,
 * but this service validates again because the database JSON is the
 * source used at this stage.
 */
export const buildJobDependencyRows = (
  runId: string,
  pipeline: NormalizedPipeline,
  jobIdsByKey: JobKeyToId,
): JobDependencyInsert[] => {
  const rows: JobDependencyInsert[] = [];

  for (const [jobKey, job] of Object.entries(pipeline.jobs)) {
    const jobId = jobIdsByKey.get(jobKey);

    if (!jobId) {
      throw new AppError(
        `Job "${jobKey}" was not created`,
        500,
      );
    }

    const seenDependencies = new Set<string>();

    for (const dependencyKey of job.dependsOn) {
      if (dependencyKey === jobKey) {
        throw new AppError(
          `Job "${jobKey}" cannot depend on itself`,
          400,
        );
      }

      if (seenDependencies.has(dependencyKey)) {
        throw new AppError(
          `Job "${jobKey}" contains duplicate dependency "${dependencyKey}"`,
          400,
        );
      }

      seenDependencies.add(dependencyKey);

      const dependsOnJobId = jobIdsByKey.get(dependencyKey);

      if (!dependsOnJobId) {
        throw new AppError(
          `Dependency "${dependencyKey}" for job "${jobKey}" does not exist`,
          400,
        );
      }

      rows.push({
        runId,
        jobId,
        dependsOnJobId,
      });
    }
  }

  return rows;
};