import { isIP } from "node:net";
import { z } from "zod";

const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const S3_BUCKET_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])$/;
const HOST_PATTERN = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/;
const CONTAINER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/;

const secretNameSchema = z.string().trim().regex(
  SECRET_NAME_PATTERN,
  "Secret name must use uppercase letters, numbers, and underscores and start with a letter",
);

const portSchema = z.coerce.number().int().min(1).max(65535);

const s3TargetConfigSchema = z.looseObject({
  bucketName: z.string().trim().min(3).max(63)
    .regex(S3_BUCKET_PATTERN)
    .refine((name) =>
        !name.includes("..") &&
        !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(name),
      "Invalid S3 bucket name",
    ),
  region: z.string().trim().min(1).max(100).regex(/^[a-z0-9-]+$/),
  prefix: z.string().trim().min(1).max(512)
    .refine((value) => {
      if (value === ".") return true;
      if (value.startsWith("/") || value.includes("\\") || value.includes(":")) {
        return false;
      }
      const normalized = value.replace(/\/+$/, "");

      if (!normalized) return false;

      return normalized.split("/").every((part) =>
            part.length > 0 &&
            part !== "." &&
            part !== "..",
        );
    }, "Use a relative prefix such as 'production', or '.' for a dedicated bucket root"),
});

const sshTargetConfigSchema = z.looseObject({
  host: z.string().trim().min(1).max(255)
    .refine((value) =>
        !/[\s\u0000-\u001f\u007f]/.test(value) &&
        !value.startsWith("-") &&
        (isIP(value) !== 0 || (
            !/^(?:\d+\.){3}\d+$/.test(value) &&
            HOST_PATTERN.test(value)
          )
        ),
      "Host must be a valid IP address or DNS hostname",
    ),

  sshPort: portSchema.optional(),
  username: z.string().trim().min(1).max(32).regex(/^[a-z_][a-z0-9_-]{0,31}$/),
  privateKeySecretName: secretNameSchema,
  knownHostsSecretName: secretNameSchema,
  containerName: z.string().trim().min(1).max(48).regex(CONTAINER_NAME_PATTERN),
  hostPort: portSchema.optional(),
  containerPort: portSchema.optional(),
  envFileSecretName: secretNameSchema.optional(),
});

const addTargetConfigIssues = (
  targetType: "ssh_ec2" | "s3",
  targetConfig: Record<string, unknown>,
  ctx: z.RefinementCtx,
): void => {
  const result = (targetType === "s3" ? s3TargetConfigSchema : sshTargetConfigSchema).safeParse(targetConfig);
  if (result.success) return;

  for (const issue of result.error.issues) {
    ctx.addIssue({
      code: "custom",
      path: ["targetConfig", ...issue.path],
      message: issue.message,
    });
  }
};

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
}).superRefine((data, ctx) => {
  addTargetConfigIssues(data.targetType, data.targetConfig, ctx);
  if (data.targetType === "ssh_ec2" && !data.healthCheckUrl) {
    ctx.addIssue({
      code: "custom",
      path: ["healthCheckUrl"],
      message: "Health check URL is required for SSH EC2 environments",
    });
  }
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
  .superRefine((data, ctx) => {
    if (Object.keys(data).length === 0) {
      ctx.addIssue({ code: "custom", message: "At least one field must be provided" });
    }

    // targetConfig cannot be validated safely without knowing which executor
    // consumes it. Require targetType alongside targetConfig updates; editing an
    // environment sends the existing target type and leaves it unchanged.
    if (data.targetConfig !== undefined && data.targetType === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["targetType"],
        message: "targetType must be included when updating targetConfig",
      });
    }
    if (data.targetType !== undefined && data.targetConfig === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["targetConfig"],
        message: "targetConfig must be included when updating targetType",
      });
    }
    if (data.targetConfig !== undefined && data.targetType !== undefined) {
      addTargetConfigIssues(data.targetType, data.targetConfig, ctx);
    }
    if (data.targetType === "ssh_ec2" && data.healthCheckUrl === undefined && data.targetConfig !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["healthCheckUrl"],
        message: "Include the environment's healthCheckUrl when updating an SSH EC2 target",
      });
    }
    if (data.targetType === "ssh_ec2" && data.healthCheckUrl === null) {
      ctx.addIssue({ code: "custom", path: ["healthCheckUrl"], message: "SSH EC2 environments require a health check URL" });
    }
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
