import * as z from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().trim().min(1).max(1000),
  CLIENT_URL: z.string().trim().min(1).max(1000),
  REDIS_URL: z.string().trim().min(1).max(1000),
  S3_ARTIFACT_BUCKET: z.string().trim().min(3).max(255),
  S3_LOG_BUCKET: z.string().trim().min(3).max(255),
  S3_REGION: z.string().trim().min(1).max(100),
  ECR_REGION: z.string().trim().min(1).max(100),
  ARTIFACT_RETENTION_DAYS: z.coerce.number().int().min(1).max(30),
  COOKIE_SECRET: z.string().min(10),
  WORKSPACE_ROOT: z.string().min(1).default(".data/workspaces"),
  JOB_MAX_TIMEOUT_MINUTES : z.number().int().min(3).max(10).default(3)
});

export const env = envSchema.parse({
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT,
  CLIENT_URL: process.env.CLIENT_URL ?? "http://localhost:5173",
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
  S3_REGION: process.env.S3_REGION,
  ECR_REGION: process.env.ECR_REGION ?? process.env.S3_REGION,
  S3_ARTIFACTS_BUCKET: process.env.S3_ARTIFACTS_BUCKET,
  S3_LOGS_BUCKET: process.env.S3_LOGS_BUCKET,
  ARTIFACT_RETENTION_DAYS: process.env.ARTIFACT_RETENTION_DAYS,
  JOB_MAX_TIMEOUT_MINUTES: process.env.JOB_MAX_TIMEOUT_MINUTES,
  COOKIE_SECRET : process.env.COOKIE_SECRET
});
