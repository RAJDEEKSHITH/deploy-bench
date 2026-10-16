import { z } from "zod";

export const projectEnvironmentParamsSchema = z.object({
  projectId: z.uuid("Invalid project ID"),
});

export const projectEnvironmentIdParamsSchema = z.object({
  projectId: z.uuid("Invalid project ID"),
  environmentId: z.uuid("Invalid environment ID"),
});

export const environmentIdParamSchema = z.object({
  environmentId: z.uuid("Invalid environment ID"),
});

export const deploymentIdParamSchema = z.object({
  deploymentId: z.uuid("Invalid deployment ID"),
});

export const createEnvironmentSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(128),
  slug: z
    .string()
    .trim()
    .min(1, "Slug is required")
    .max(128)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase alphanumeric with hyphens"),
  targetType: z.enum(["ssh_ec2", "s3"]),
  targetConfig: z.record(z.string(), z.unknown()).default({}),
  deploymentBranch: z.string().trim().min(1, "Deployment branch is required").max(128),
  healthCheckUrl: z.string().trim().url("Must be a valid URL").nullable().optional(),
  healthCheckTimeoutSeconds: z.coerce.number().int().min(1).max(600).default(30),
});

export const updateEnvironmentSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
    targetType: z.enum(["ssh_ec2", "s3"]).optional(),
    targetConfig: z.record(z.string(), z.unknown()).optional(),
    deploymentBranch: z.string().trim().min(1).max(128).optional(),
    healthCheckUrl: z.string().trim().url().nullable().optional(),
    healthCheckTimeoutSeconds: z.coerce.number().int().min(1).max(600).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export const createDeploymentSchema = z.object({
  runId: z.uuid("Invalid run ID"),
  artifactId: z.uuid("Invalid artifact ID").optional(),
  containerImageId: z.uuid("Invalid container image ID").optional(),
});

export const rollbackDeploymentSchema = z.object({
  targetDeploymentId: z.uuid("Invalid target deployment ID").optional(),
});

export type CreateEnvironmentBody = z.infer<typeof createEnvironmentSchema>;
export type UpdateEnvironmentBody = z.infer<typeof updateEnvironmentSchema>;
export type CreateDeploymentBody = z.infer<typeof createDeploymentSchema>;
export type RollbackDeploymentBody = z.infer<typeof rollbackDeploymentSchema>;