ALTER TABLE "deployments" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "deployments" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
DROP TYPE "deployment_status";--> statement-breakpoint
CREATE TYPE "deployment_status" AS ENUM('queued', 'deploying', 'verifying', 'success', 'failed', 'cancelled', 'superseded');--> statement-breakpoint
ALTER TABLE "deployments" ALTER COLUMN "status" SET DATA TYPE "deployment_status" USING "status"::"deployment_status";--> statement-breakpoint
ALTER TABLE "deployments" ALTER COLUMN "status" SET DEFAULT 'queued'::"deployment_status";--> statement-breakpoint
ALTER TABLE "dead_letters" ALTER COLUMN "failure_class" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "job_attempts" ALTER COLUMN "failure_class" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "failure_class";--> statement-breakpoint
CREATE TYPE "failure_class" AS ENUM('configuration', 'user_code', 'dependency', 'infrastructure', 'timeout', 'authorization', 'cancelled', 'unknown');--> statement-breakpoint
ALTER TABLE "dead_letters" ALTER COLUMN "failure_class" SET DATA TYPE "failure_class" USING "failure_class"::"failure_class";--> statement-breakpoint
ALTER TABLE "job_attempts" ALTER COLUMN "failure_class" SET DATA TYPE "failure_class" USING "failure_class"::"failure_class";--> statement-breakpoint
ALTER TABLE "job_attempts" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "job_attempts" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
DROP TYPE "job_attempt_status";--> statement-breakpoint
CREATE TYPE "job_attempt_status" AS ENUM('queued', 'running', 'success', 'failed', 'cancelled', 'timed_out');--> statement-breakpoint
ALTER TABLE "job_attempts" ALTER COLUMN "status" SET DATA TYPE "job_attempt_status" USING "status"::"job_attempt_status";--> statement-breakpoint
ALTER TABLE "job_attempts" ALTER COLUMN "status" SET DEFAULT 'queued'::"job_attempt_status";--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
DROP TYPE "run_status";--> statement-breakpoint
CREATE TYPE "run_status" AS ENUM('queued', 'running', 'success', 'failed', 'cancelled', 'superseded');--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "status" SET DATA TYPE "run_status" USING "status"::"run_status";--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "status" SET DEFAULT 'queued'::"run_status";--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "size_in_bytes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "definition" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_versions" ALTER COLUMN "path" SET DATA TYPE varchar(512) USING "path"::varchar(512);--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "github_integration_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_run_environment_unique" ON "deployments" ("run_id","environment_id") WHERE "status" NOT IN ('failed','cancelled');--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_one_active_per_env" ON "deployments" ("environment_id") WHERE "status" IN ('queued', 'deploying', 'verifying');--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_versions_project_commit__path_unique" ON "pipeline_versions" ("project_id","commit_sha","path");--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_desired_run_id_runs_id_fkey" FOREIGN KEY ("desired_run_id") REFERENCES "runs"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_deploy_requires_run" CHECK ("action" <> 'deploy' OR "run_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_backend_health_check_required" CHECK ("target_type" <> 'ssh_ec2' OR "health_check_url" IS NOT NULL);