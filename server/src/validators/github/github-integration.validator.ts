import * as z from "zod";

export const createGithubIntegrationSchema = z.strictObject({
  webhookSecret: z
  .string().min(1, "Webhook secret is required")
  .max(1024, "Webhook secret is too long"),
  accessTokenSecretName: z
    .string()
    .trim()
    .min(1, "Access token secret name cannot be empty")
    .max(128)
    .optional(),
  enabled: z.boolean().default(true),
});

export const updateGithubIntegrationSchema = z
  .strictObject({
    webhookSecret: z
      .string()
      .min(1, "Webhook secret cannot be empty")
      .max(1024, "Webhook secret is too long")
      .optional(),
    accessTokenSecretName: z
      .string()
      .trim()
      .min(1, "Access token secret name cannot be empty")
      .max(128)
      .nullable()
      .optional(),
    enabled: z
      .boolean()
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    error: "At least one field is required",
  });

export const projectIdParamSchema = z.strictObject({
  projectId: z.uuidv4({
    error: "Invalid project ID",
  }),
});

export type CreateGithubIntegration = z.infer<typeof createGithubIntegrationSchema>;

export type UpdateGithubIntegration = z.infer<typeof updateGithubIntegrationSchema>;

export type GithubIntegrationProjectParams = z.infer<typeof projectIdParamSchema>;