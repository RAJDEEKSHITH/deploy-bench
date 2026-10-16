import * as z from "zod";

const MAX_SECRET_VALUE_BYTES = 64 * 1024;

const secretNameSchema = z
  .string()
  .trim()
  .min(1,"Secret name is required")
  .max(128,"Secret name cannot exceed 128 characters")
  .regex(/^[A-Z][A-Z0-9_]*$/,
      "Secret name must contain only uppercase letters, numbers and underscores, and must start with a letter",
  );

const secretValueSchema = z
  .string()
  .min(1,"Secret value is required")
  .refine(
    (value) =>
      Buffer.byteLength(value, "utf8") <= MAX_SECRET_VALUE_BYTES,
      "Secret value cannot exceed 64 KB",
  );

export const createSecretSchema =
  z.strictObject({
    name: secretNameSchema,
    value: secretValueSchema,
  });

export const updateSecretSchema = z
  .strictObject({
    name: secretNameSchema.optional(),
    value: secretValueSchema.optional(),
  })
  .refine((data) =>data.name !== undefined || data.value !== undefined,
  "At least one field is required",
  );

export const projectSecretParamsSchema =
  z.strictObject({projectId: z.uuidv4("Invalid project ID")});

export const projectSecretIdParamsSchema =
  z.strictObject({
    projectId: z.uuidv4("Invalid project ID"),
    secretId: z.uuidv4("Invalid secret ID"),
  });

export const environmentSecretParamsSchema =
  z.strictObject({
    projectId: z.uuidv4("Invalid project ID"),
    environmentId: z.uuidv4("Invalid environment ID"),
  });

export const environmentSecretIdParamsSchema =
  z.strictObject({
    projectId: z.uuidv4("Invalid project ID"),
    environmentId: z.uuidv4("Invalid environment ID"),
    secretId: z.uuidv4("Invalid secret ID"),
  });

export type CreateSecretInput = z.infer<typeof createSecretSchema>;
export type UpdateSecretInput = z.infer<typeof updateSecretSchema>;
export type ProjectSecretParams = z.infer<typeof projectSecretParamsSchema>;
export type ProjectSecretIdParams =z.infer<typeof projectSecretIdParamsSchema>;
export type EnvironmentSecretParams =z.infer<typeof environmentSecretParamsSchema>;
export type EnvironmentSecretIdParams =z.infer<typeof environmentSecretIdParamsSchema>;