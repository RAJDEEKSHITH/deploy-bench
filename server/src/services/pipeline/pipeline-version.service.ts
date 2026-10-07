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
const MAX_PIPELINE_PATH_LENGTH = 512; // pipeline_versions.path

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export type ProcessPipelineVersionInput = {
  projectId: string;
  commitSha: string;
  pipelinePath: string;
  repositoryUrl: string;
  accessToken?: string | undefined;
};

export type ProcessPipelineVersionResult = {
  pipelineVersionId: string;
  validationStatus: "valid" | "invalid";
  configHash: string;
};

/** What gets stored. Mirrors pipeline_versions_validation_consistency_check. */
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

/**
 * Invalid pipelines still need a config_hash (NOT NULL),
 * so they get the hash of their exact raw text.
 */
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

  // PostgreSQL text columns cannot store NUL bytes.
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
  configHash: pipelineVersions.configHash,
};

const findPipelineVersion = async (projectId: string, commitSha: string) => {
  const [row] = await db
    .select(versionColumns)
    .from(pipelineVersions)
    .where(and(eq(pipelineVersions.projectId, projectId), eq(pipelineVersions.commitSha, commitSha)))
    .limit(1);

  return row;
};

const toResult = (row: {
  id: string;
  validationStatus: "valid" | "invalid";
  configHash: string;
}): ProcessPipelineVersionResult => ({
  pipelineVersionId: row.id,
  validationStatus: row.validationStatus,
  configHash: row.configHash,
});

/**
 * Reads, parses, validates and normalizes the pipeline at an exact commit,
 * then stores one immutable pipeline_versions row per (project, commit).
 *
 * Idempotent: webhook redelivery / job retry returns the existing row
 * without touching git. Rows are never updated.
 */
export const processPipelineVersion = async ({
  projectId,
  commitSha: rawCommitSha,
  pipelinePath,
  repositoryUrl,
  accessToken,
}: ProcessPipelineVersionInput): Promise<ProcessPipelineVersionResult> => {
  const commitSha = rawCommitSha.toLowerCase();

  if (pipelinePath.length > MAX_PIPELINE_PATH_LENGTH) {
    throw new AppError("Pipeline path is too long", 400);
  }

  const existing = await findPipelineVersion(projectId, commitSha);
  if (existing) return toResult(existing);

  const rawYaml = await readPipelineAtCommit({
    repositoryUrl,
    commitSha,
    pipelinePath,
    accessToken,
  });

  const outcome = evaluatePipeline(rawYaml, pipelinePath);

  const [inserted] = await db
    .insert(pipelineVersions)
    .values({ projectId, path: pipelinePath, commitSha, ...outcome })
    .onConflictDoNothing({ target: [pipelineVersions.projectId, pipelineVersions.commitSha] })
    .returning(versionColumns);

  if (inserted) return toResult(inserted);

  // Another worker inserted the same (project, commit) first.
  const winner = await findPipelineVersion(projectId, commitSha);
  if (!winner) throw new AppError("Pipeline version could not be resolved after conflict", 500);

  return toResult(winner);
};