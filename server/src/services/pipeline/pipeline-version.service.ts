import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { db } from "../../db/index.js";
import { pipelineVersions } from "../../db/schema.js";
import { AppError } from "../../utils/app.error.js";
import { readPipelineAtCommit } from "./pipeline-reader.service.js";
import { parsePipelineYaml, PipelineParseError } from "./pipeline-parser.service.js";
import { validatePipeline } from "./pipeline-validator.service.js";
import { normalizePipeline, type NormalizedPipeline } from "./pipeline-normalizer.service.js";

const MAX_VALIDATION_ERROR_LENGTH = 2_000;
const MAX_PIPELINE_PATH_LENGTH = 512;
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export type ProcessPipelineVersionInput = {
  projectId: string;
  commitSha: string;
  pipelinePath: string;
  repositoryUrl: string;
  accessToken?: string | undefined;
};

export type ProcessRawPipelineVersionInput = {
  projectId: string;
  commitSha: string;
  pipelinePath: string;
  rawYaml: string;
};

export type ProcessPipelineVersionResult = {
  pipelineVersionId: string;
  validationStatus: "valid" | "invalid";
  validationError: string | null;
  configHash: string;
};

type PipelineOutcome =
  | {
      validationStatus: "valid";
      rawYaml: string;
      normalizedYaml: NormalizedPipeline;
      validationError: null;
      configHash: string;
    }
  | {
      validationStatus: "invalid";
      rawYaml: string;
      normalizedYaml: null;
      validationError: string;
      configHash: string;
    };

const invalidOutcome = (rawYaml: string, message: string): PipelineOutcome => ({
  validationStatus: "invalid",
  rawYaml,
  normalizedYaml: null,
  validationError: (message.trim() || "Invalid pipeline").slice(0, MAX_VALIDATION_ERROR_LENGTH),
  configHash: sha256(rawYaml),
});

const evaluatePipeline = (rawYaml: string | null, pipelinePath: string): PipelineOutcome => {
  if (rawYaml === null) {
    return invalidOutcome("", `Pipeline file "${pipelinePath}" was not found at this commit`);
  }

  if (rawYaml.includes("\0")) {
    return invalidOutcome("", "Pipeline file must be a text file");
  }

  let parsed: unknown;
  try {
    parsed = parsePipelineYaml(rawYaml);
  } catch (error) {
    if (error instanceof PipelineParseError) return invalidOutcome(rawYaml, error.message);
    throw error;
  }

  const validation = validatePipeline(parsed);
  if (!validation.valid) return invalidOutcome(rawYaml, validation.error);

  const { normalizedPipeline, configHash } = normalizePipeline(validation.pipeline);
  return {
    validationStatus: "valid",
    rawYaml,
    normalizedYaml: normalizedPipeline,
    validationError: null,
    configHash,
  };
};

const versionColumns = {
  id: pipelineVersions.id,
  validationStatus: pipelineVersions.validationStatus,
  validationError: pipelineVersions.validationError,
  configHash: pipelineVersions.configHash,
};

const findPipelineVersion = async (projectId: string, commitSha: string, pipelinePath: string) => {
  const [row] = await db
    .select(versionColumns)
    .from(pipelineVersions)
    .where(and(
      eq(pipelineVersions.projectId, projectId),
      eq(pipelineVersions.commitSha, commitSha),
      eq(pipelineVersions.path, pipelinePath),
    ))
    .limit(1);
  return row;
};

const toResult = (row: {
  id: string;
  validationStatus: "valid" | "invalid";
  validationError: string | null;
  configHash: string;
}): ProcessPipelineVersionResult => ({
  pipelineVersionId: row.id,
  validationStatus: row.validationStatus,
  validationError: row.validationError,
  configHash: row.configHash,
});

const persistPipelineVersion = async ({
  projectId,
  commitSha: rawCommitSha,
  pipelinePath,
  outcome,
}: {
  projectId: string;
  commitSha: string;
  pipelinePath: string;
  outcome: PipelineOutcome;
}): Promise<ProcessPipelineVersionResult> => {
  const commitSha = rawCommitSha.toLowerCase();
  if (pipelinePath.trim().length === 0 || pipelinePath.length > MAX_PIPELINE_PATH_LENGTH) {
    throw new AppError("Pipeline path is invalid or too long", 400);
  }

  const existing = await findPipelineVersion(projectId, commitSha, pipelinePath);
  if (existing) return toResult(existing);

  // Match the database's actual unique key: project + commit + path.
  const [inserted] = await db
    .insert(pipelineVersions)
    .values({ projectId, path: pipelinePath, commitSha, ...outcome })
    .onConflictDoNothing({
      target: [pipelineVersions.projectId, pipelineVersions.commitSha, pipelineVersions.path],
    })
    .returning(versionColumns);

  if (inserted) return toResult(inserted);

  const winner = await findPipelineVersion(projectId, commitSha, pipelinePath);
  if (!winner) throw new AppError("Pipeline version could not be resolved after conflict", 500);
  return toResult(winner);
};

/** Read, parse, validate and normalize the repository pipeline at an exact commit. */
export const processPipelineVersion = async ({
  projectId,
  commitSha,
  pipelinePath,
  repositoryUrl,
  accessToken,
}: ProcessPipelineVersionInput): Promise<ProcessPipelineVersionResult> => {
  const normalizedCommitSha = commitSha.toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(normalizedCommitSha)) {
    throw new AppError("Invalid repository commit SHA", 400);
  }

  const existing = await findPipelineVersion(projectId, normalizedCommitSha, pipelinePath);
  if (existing) return toResult(existing);

  const rawYaml = await readPipelineAtCommit({
    repositoryUrl,
    commitSha: normalizedCommitSha,
    pipelinePath,
    accessToken,
  });

  return persistPipelineVersion({
    projectId,
    commitSha: normalizedCommitSha,
    pipelinePath,
    outcome: evaluatePipeline(rawYaml, pipelinePath),
  });
};

/**
 * Validate a caller-provided manual pipeline with the same strict contract as
 * repository pipelines. The caller gives it a distinct immutable path so it
 * cannot overwrite the pipeline that was actually committed to the repository.
 */
export const processRawPipelineVersion = async ({
  projectId,
  commitSha,
  pipelinePath,
  rawYaml,
}: ProcessRawPipelineVersionInput): Promise<ProcessPipelineVersionResult> => {
  if (rawYaml.length > 65_536) throw new AppError("Pipeline YAML is too large", 413);
  return persistPipelineVersion({
    projectId,
    commitSha,
    pipelinePath,
    outcome: evaluatePipeline(rawYaml, pipelinePath),
  });
};
