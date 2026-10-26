import { z } from "zod";

export const projectRunsParamSchema = z.object({
  projectId: z.uuid("Invalid project ID"),
});

export const runIdParamSchema = z.object({
  runId: z.uuid("Invalid run ID"),
});

export const projectRunIdParamSchema = z.object({
  projectId: z.uuid("Invalid project ID"),
  runId: z.uuid("Invalid run ID"),
});

export const triggerManualRunSchema = z.object({
  branch: z
    .string()
    .trim()
    .min(1, "Branch is required")
    .max(128, "Branch cannot exceed 128 characters")
    .optional(),
  commitSha: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{7,128}$/, "Commit SHA must be a valid hex SHA (7-128 chars)")
    .optional(),
  rawYaml: z
    .string()
    .trim()
    .min(1, "Pipeline YAML cannot be empty")
    .max(65536, "Pipeline YAML is too large")
    .optional(),
});

export type ProjectRunsParams = z.infer<typeof projectRunsParamSchema>;
export type RunIdParams = z.infer<typeof runIdParamSchema>;
export type ProjectRunIdParams = z.infer<typeof projectRunIdParamSchema>;
export type TriggerManualRunInput = z.infer<typeof triggerManualRunSchema>;