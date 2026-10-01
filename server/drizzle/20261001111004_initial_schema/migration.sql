CREATE TYPE "artifact_kind" AS ENUM('archive', 'file');--> statement-breakpoint
CREATE TYPE "artifact_status" AS ENUM('uploading', 'ready', 'failed', 'expired', 'deleted');--> statement-breakpoint
CREATE TYPE "dead_letter_status" AS ENUM('open', 'replayed', 'resolved', 'discarded');--> statement-breakpoint
CREATE TYPE "deployment_action" AS ENUM('deploy', 'rollback');--> statement-breakpoint
CREATE TYPE "deployment_status" AS ENUM('queued', 'deploying', 'verifying', 'success', 'failed', 'canceled', 'superseded');--> statement-breakpoint
CREATE TYPE "deployment_target_type" AS ENUM('ssh_ec2', 's3');--> statement-breakpoint
CREATE TYPE "failure_class" AS ENUM('configuration', 'user_code', 'dependency', 'infrastructure', 'timeout', 'authorization', 'canceled', 'unknown');--> statement-breakpoint
CREATE TYPE "job_attempt_status" AS ENUM('queued', 'running', 'success', 'failed', 'canceled', 'timed_out');--> statement-breakpoint
CREATE TYPE "job_status" AS ENUM('blocked', 'queued', 'running', 'succcess', 'failed', 'cancelled', 'skipped');--> statement-breakpoint
CREATE TYPE "log_stream_status" AS ENUM('open', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "log_stream_type" AS ENUM('stdout', 'stderr', 'system');--> statement-breakpoint
CREATE TYPE "outbox_status" AS ENUM('pending', 'publishing', 'published', 'failed', 'dead_lettered');--> statement-breakpoint
CREATE TYPE "pipeline_validation_status" AS ENUM('valid', 'invalid');--> statement-breakpoint
CREATE TYPE "run_status" AS ENUM('queued', 'running', 'success', 'failed', 'canceled', 'superseded');--> statement-breakpoint
CREATE TYPE "run_trigger" AS ENUM('push', 'manual', 'retry');--> statement-breakpoint
CREATE TYPE "webhook_status" AS ENUM('recevied', 'queued', 'processing', 'processed', 'failed', 'ignored', 'dead_lettered');--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"run_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"kind" "artifact_kind" DEFAULT 'archive'::"artifact_kind" NOT NULL,
	"content_type" varchar(255),
	"producer_job_id" uuid,
	"producer_job_attempt_id" uuid,
	"status" "artifact_status" DEFAULT 'uploading'::"artifact_status" NOT NULL,
	"sha256" varchar(64),
	"s3_bucket_name" varchar(128) NOT NULL,
	"object_key" text NOT NULL,
	"size_in_bytes" bigint NOT NULL,
	"expires_at" timestamp with time zone,
	"uploaded_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_size_check" CHECK ("size_in_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "branch_heads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"project_id" uuid NOT NULL,
	"branch" varchar(128) NOT NULL,
	"commit_sha" varchar(128) NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"source_webhook_delivery_id" uuid,
	"last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "container_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" varchar(120) NOT NULL,
	"run_id" uuid NOT NULL,
	"tag" varchar(128) NOT NULL,
	"digest" varchar(128) NOT NULL,
	"producer_job_id" uuid,
	"producer_job_attempt_id" uuid,
	"registry" varchar(255) NOT NULL,
	"repository" varchar(256) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dead_letters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"status" "dead_letter_status" DEFAULT 'open'::"dead_letter_status" NOT NULL,
	"source_type" varchar(64) NOT NULL,
	"source_id" varchar(128) NOT NULL,
	"queue_name" varchar(120),
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"replay_count" integer DEFAULT 0 NOT NULL,
	"failure_class" "failure_class",
	"error_code" varchar(128),
	"error_message" text NOT NULL,
	"first_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replayed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dead_letters_attempts_check" CHECK ("attempts" >= 0),
	CONSTRAINT "dead_letters_replay_count_check" CHECK ("replay_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"run_id" uuid,
	"environment_id" uuid NOT NULL,
	"rollback_to_deployment_id" uuid,
	"container_image_id" uuid,
	"artifact_id" uuid,
	"action" "deployment_action" NOT NULL,
	"status" "deployment_status" DEFAULT 'queued'::"deployment_status" NOT NULL,
	"commit_sha" varchar(128) NOT NULL,
	"previous_commit_sha" varchar(128) NOT NULL,
	"release_ref" varchar(512) NOT NULL,
	"previous_release_ref" varchar(512),
	"error_code" varchar(128),
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployments_rollback_target_check" CHECK (
        (
          "action" = 'rollback'
          AND
          "rollback_to_deployment_id" IS NOT NULL
        )
        OR
        (
          "action" = 'deploy'
          AND
          "rollback_to_deployment_id" IS NULL
        )
      )
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"project_id" uuid,
	"name" varchar(128) NOT NULL,
	"slug" varchar(128) NOT NULL,
	"target_type" "deployment_target_type" NOT NULL,
	"target_config" jsonb NOT NULL,
	"deployment_branch" varchar(128) NOT NULL,
	"health_check_url" text,
	"health_check_timeout_seconds" integer DEFAULT 30 NOT NULL,
	"desired_commit_sha" varchar(128),
	"current_commit_sha" varchar(128),
	"current_release_ref" varchar(128),
	"current_image_id" uuid,
	"current_artifact_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environments_health_timeout_check" CHECK ("health_check_timeout_seconds" > 0),
	CONSTRAINT "environments_current_target_check" CHECK (
        (
          "target_type" = 'ssh_ec2'
          AND "current_artifact_id" IS NULL
        )
        OR
        (
          "target_type" = 's3'
          AND "current_image_id" IS NULL
        )
      )
);
--> statement-breakpoint
CREATE TABLE "github_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"project_id" uuid NOT NULL,
	"repository_full_name" varchar(256) NOT NULL,
	"webhook_secret_cipher_text" text NOT NULL,
	"webhook_secret_iv" varchar(128) NOT NULL,
	"webhook_secret_auth_tag" varchar(128) NOT NULL,
	"webhook_secret_version" integer DEFAULT 1 NOT NULL,
	"access_token_secret_name" varchar(128) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_integrations_webhook_secret_version" CHECK ("webhook_secret_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "job_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"job_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" "job_attempt_status" DEFAULT 'queued'::"job_attempt_status" NOT NULL,
	"queue_name" varchar(120) NOT NULL,
	"queue_job_id" varchar(255),
	"lease_token" varchar(128),
	"heartbeat_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"failure_class" "failure_class",
	"retryable" boolean,
	"step_results" jsonb,
	"started_at" timestamp with time zone,
	"container_id" varchar(256),
	"exit_code" integer,
	"error_code" varchar(128),
	"error_message" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_attempts_attempt_number_check" CHECK ("attempt_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "job_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"run_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"depends_on_job_id" uuid,
	CONSTRAINT "job_dependencies_not_self_check" CHECK ("job_id" <> "depends_on_job_id")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"run_id" uuid NOT NULL,
	"key" varchar(120) NOT NULL,
	"name" varchar(128) NOT NULL,
	"definition" jsonb,
	"status" "job_status" DEFAULT 'blocked'::"job_status" NOT NULL,
	"allow_failure" boolean DEFAULT false NOT NULL,
	"error_code" varchar(100),
	"error_message" text,
	"timeout_seconds" integer DEFAULT 3600 NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_timeout_check" CHECK ("timeout_seconds" > 0),
	CONSTRAINT "jobs_max_attempts_check" CHECK ("max_attempts" >= 1 AND "max_attempts" <= 5)
);
--> statement-breakpoint
CREATE TABLE "log_chunks" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "log_chunks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"log_stream_id" uuid NOT NULL,
	"size_in_bytes" integer,
	"s3_key" text NOT NULL,
	"sequence" integer NOT NULL,
	"line_count" integer NOT NULL,
	"sha256" varchar(128) NOT NULL,
	"first_timestamp" timestamp with time zone,
	"last_timestamp" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "log_chunks_sequence_check" CHECK ("sequence" >= 0),
	CONSTRAINT "log_chunks_size_check" CHECK ("size_in_bytes" >= 0),
	CONSTRAINT "log_chunks_line_count_check" CHECK ("line_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "log_streams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"job_attempt_id" uuid NOT NULL,
	"stream_type" "log_stream_type" NOT NULL,
	"status" "log_stream_status" DEFAULT 'open'::"log_stream_status" NOT NULL,
	"s3_bucket" varchar(256) NOT NULL,
	"s3_prefix" text NOT NULL,
	"total_bytes" bigint DEFAULT 0 NOT NULL,
	"total_lines" bigint DEFAULT 0 NOT NULL,
	"last_sequence" integer DEFAULT -1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "log_streams_last_sequence_check" CHECK ("last_sequence" >= -1)
);
--> statement-breakpoint
CREATE TABLE "outbox_messages" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"message_type" varchar(120) NOT NULL,
	"aggregate_type" varchar(64) NOT NULL,
	"aggregate_id" varchar(128) NOT NULL,
	"dedupe_key" varchar(255) NOT NULL,
	"payload" jsonb NOT NULL,
	"queue_name" varchar(120) NOT NULL,
	"status" "outbox_status" DEFAULT 'pending'::"outbox_status" NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" varchar(128),
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_attempt_count_check" CHECK ("attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pipeline_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"project_id" uuid NOT NULL,
	"path" varchar(256) NOT NULL,
	"config_hash" varchar(128) NOT NULL,
	"commit_sha" varchar(128) NOT NULL,
	"raw_yaml" text NOT NULL,
	"normalized_yaml" jsonb,
	"validation_status" "pipeline_validation_status" NOT NULL,
	"validation_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_versions_validation_consistency_check" CHECK (
        (
          "validation_status" = 'valid'
          AND "normalized_yaml" IS NOT NULL
          AND "validation_error" IS NULL
        )
        OR
        (
          "validation_status" = 'invalid'
          AND "normalized_yaml" IS NULL
          AND "validation_error" IS NOT NULL
        )
      )
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" varchar(128) NOT NULL,
	"slug" varchar(120) NOT NULL,
	"repository_url" varchar(512) NOT NULL,
	"repository_full_name" varchar(256) NOT NULL,
	"default_branch" varchar(128) NOT NULL,
	"pipeline_path" varchar(512) DEFAULT '.cicd/pipeline.yaml' NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"project_id" uuid NOT NULL,
	"pipeline_version_id" uuid NOT NULL,
	"webhook_delivery_id" uuid,
	"commit_sha" varchar(128) NOT NULL,
	"branch" varchar(128) NOT NULL,
	"status" "run_status" DEFAULT 'queued'::"run_status" NOT NULL,
	"trigger" "run_trigger" NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"superseded_by_run_id" uuid,
	"error_code" varchar(128),
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" varchar(128) NOT NULL,
	"project_id" uuid,
	"environment_id" uuid,
	"cipher_text" text NOT NULL,
	"iv" varchar(128) NOT NULL,
	"auth_tag" varchar(128) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secrets_excatly_one_scope_check" CHECK ((
      ("project_id" IS NOT NULL AND "environment_id" IS NULL)
      OR
     ("project_id" IS NULL AND "environment_id" IS NOT NULL)
     )),
	CONSTRAINT "secrets_version_check" CHECK ("version" > 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"email" varchar(255) NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"project_id" uuid,
	"github_integration_id" uuid,
	"github_delivery_id" varchar(128) NOT NULL,
	"status" "webhook_status" DEFAULT 'recevied'::"webhook_status" NOT NULL,
	"event_name" varchar(64) NOT NULL,
	"ref" varchar(512),
	"is_forced" boolean NOT NULL,
	"is_deleted" boolean NOT NULL,
	"is_signature_valid" boolean NOT NULL,
	"payload" jsonb NOT NULL,
	"before_sha" varchar(256) NOT NULL,
	"after_sha" varchar(256) NOT NULL,
	"last_error" text,
	"recevied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"attempted_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dead_lettered_at" timestamp with time zone,
	CONSTRAINT "webhook_deliveries_attempt_count_check" CHECK ("attempt_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_run_id_name" ON "artifacts" ("run_id","name");--> statement-breakpoint
CREATE INDEX "artifacts_status_expiry_idx" ON "artifacts" ("status","expires_at");--> statement-breakpoint
CREATE INDEX "artifacts_run_idx" ON "artifacts" ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "branch_heads_project_id_branch" ON "branch_heads" ("project_id","branch");--> statement-breakpoint
CREATE INDEX "branch_heads_project_idx" ON "branch_heads" ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "container_images_registry_repository_tag_unique" ON "container_images" ("registry","repository","tag");--> statement-breakpoint
CREATE INDEX "container_images_repository_idx" ON "container_images" ("repository","tag");--> statement-breakpoint
CREATE INDEX "container_images_run_idx" ON "container_images" ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dead_letters_source_unique" ON "dead_letters" ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "dead_letters_status_created_idx" ON "dead_letters" ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_run_environment_unique" ON "deployments" ("run_id","environment_id");--> statement-breakpoint
CREATE INDEX "deployments_environment_id__created_at_idx" ON "deployments" ("environment_id","created_at");--> statement-breakpoint
CREATE INDEX "deployments_run_id_idx" ON "deployments" ("run_id");--> statement-breakpoint
CREATE INDEX "deployments_rollback_to_deployment_id_idx" ON "deployments" ("rollback_to_deployment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_project_id_slug_unique" ON "environments" ("project_id","slug");--> statement-breakpoint
CREATE INDEX "environments_project_idx" ON "environments" ("project_id");--> statement-breakpoint
CREATE INDEX "environments_desired_idx" ON "environments" ("project_id","desired_commit_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "github_integrations_project_unique" ON "github_integrations" ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_attempts_job_id_attempt_number_unique" ON "job_attempts" ("job_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "job_attempts_lease_token_unique" ON "job_attempts" ("lease_token");--> statement-breakpoint
CREATE UNIQUE INDEX "job_attempts_queue_job_unique" ON "job_attempts" ("queue_name","queue_job_id");--> statement-breakpoint
CREATE INDEX "job_attempts_status_heartbeat_idx" ON "job_attempts" ("status","heartbeat_at");--> statement-breakpoint
CREATE INDEX "job_attempts_lease_idx" ON "job_attempts" ("status","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_dependencies_unique" ON "job_dependencies" ("job_id","depends_on_job_id");--> statement-breakpoint
CREATE INDEX "job_dependencies_depends_on_job_id_idx" ON "job_dependencies" ("depends_on_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_run_id_key_unique" ON "jobs" ("run_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_run_id_id_unique" ON "jobs" ("run_id","id");--> statement-breakpoint
CREATE INDEX "jobs_run_status_idx" ON "jobs" ("run_id","status");--> statement-breakpoint
CREATE INDEX "jobs_status_next_attempt_at_idx" ON "jobs" ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "log_chunks_stream_sequence_unique" ON "log_chunks" ("log_stream_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "log_chunks_s3_key_unique" ON "log_chunks" ("s3_key");--> statement-breakpoint
CREATE INDEX "log_chunks_stream_idx" ON "log_chunks" ("log_stream_id");--> statement-breakpoint
CREATE UNIQUE INDEX "log_streams_job_attempt_stream_type_unique" ON "log_streams" ("job_attempt_id","stream_type");--> statement-breakpoint
CREATE INDEX "log_streams_job_attempt_id_idx" ON "log_streams" ("job_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_dedupe_key_unique" ON "outbox_messages" ("dedupe_key");--> statement-breakpoint
CREATE INDEX "outbox_status_available_idx" ON "outbox_messages" ("status","available_at");--> statement-breakpoint
CREATE INDEX "outbox_publishing_lease_idx" ON "outbox_messages" ("status","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_versions_project_commit_unique" ON "pipeline_versions" ("project_id","commit_sha");--> statement-breakpoint
CREATE INDEX "pipeline_versions_project_idx" ON "pipeline_versions" ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_unique" ON "projects" (lower("slug"));--> statement-breakpoint
CREATE UNIQUE INDEX "projects_repository_full_name_unique" ON "projects" (lower("repository_full_name"));--> statement-breakpoint
CREATE INDEX "projects_created_by_idx" ON "projects" ("created_by_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_webhook_delivery_unique" ON "runs" ("webhook_delivery_id");--> statement-breakpoint
CREATE INDEX "runs_project_created_idx" ON "runs" ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_project_branch_created_idx" ON "runs" ("project_id","branch","created_at");--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "runs" ("status");--> statement-breakpoint
CREATE INDEX "runs_project_commit_idx" ON "runs" ("project_id","commit_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_name_in_project_unique" ON "secrets" ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_name_in_environment_unique" ON "secrets" ("environment_id","name");--> statement-breakpoint
CREATE INDEX "sessions_user_expires_idx" ON "sessions" ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_integration_delivery_unique" ON "webhook_deliveries" ("github_integration_id","github_delivery_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_retry_idx" ON "webhook_deliveries" ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_project_received_idx" ON "webhook_deliveries" ("project_id","recevied_at");--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_producer_job_id_jobs_id_fkey" FOREIGN KEY ("producer_job_id") REFERENCES "jobs"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_producer_job_attempt_id_job_attempts_id_fkey" FOREIGN KEY ("producer_job_attempt_id") REFERENCES "job_attempts"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "branch_heads" ADD CONSTRAINT "branch_heads_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "branch_heads" ADD CONSTRAINT "branch_heads_16JGh4n2QyDs_fkey" FOREIGN KEY ("source_webhook_delivery_id") REFERENCES "webhook_deliveries"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "container_images" ADD CONSTRAINT "container_images_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "container_images" ADD CONSTRAINT "container_images_producer_job_id_jobs_id_fkey" FOREIGN KEY ("producer_job_id") REFERENCES "jobs"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "container_images" ADD CONSTRAINT "container_images_producer_job_attempt_id_job_attempts_id_fkey" FOREIGN KEY ("producer_job_attempt_id") REFERENCES "job_attempts"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_environment_id_environments_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_rollback_to_deployment_id_deployments_id_fkey" FOREIGN KEY ("rollback_to_deployment_id") REFERENCES "deployments"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_container_image_id_container_images_id_fkey" FOREIGN KEY ("container_image_id") REFERENCES "container_images"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_artifact_id_artifacts_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_current_image_id_container_images_id_fkey" FOREIGN KEY ("current_image_id") REFERENCES "container_images"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_current_artifact_id_artifacts_id_fkey" FOREIGN KEY ("current_artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "github_integrations" ADD CONSTRAINT "github_integrations_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_job_id_jobs_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "job_dependencies" ADD CONSTRAINT "job_dependencies_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "job_dependencies" ADD CONSTRAINT "job_dependencies_job_id_jobs_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "job_dependencies" ADD CONSTRAINT "job_dependencies_depends_on_job_id_jobs_id_fkey" FOREIGN KEY ("depends_on_job_id") REFERENCES "jobs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "job_dependencies" ADD CONSTRAINT "job_dependencies_job_same_run_fk" FOREIGN KEY ("run_id","job_id") REFERENCES "jobs"("run_id","id");--> statement-breakpoint
ALTER TABLE "job_dependencies" ADD CONSTRAINT "job_dependencies_dependency_same_run_fk" FOREIGN KEY ("run_id","depends_on_job_id") REFERENCES "jobs"("run_id","id");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "log_chunks" ADD CONSTRAINT "log_chunks_log_stream_id_log_streams_id_fkey" FOREIGN KEY ("log_stream_id") REFERENCES "log_streams"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "log_streams" ADD CONSTRAINT "log_streams_job_attempt_id_job_attempts_id_fkey" FOREIGN KEY ("job_attempt_id") REFERENCES "job_attempts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pipeline_versions" ADD CONSTRAINT "pipeline_versions_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_id_users_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_pipeline_version_id_pipeline_versions_id_fkey" FOREIGN KEY ("pipeline_version_id") REFERENCES "pipeline_versions"("id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_webhook_delivery_id_webhook_deliveries_id_fkey" FOREIGN KEY ("webhook_delivery_id") REFERENCES "webhook_deliveries"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_superseded_by_run_id_runs_id_fkey" FOREIGN KEY ("superseded_by_run_id") REFERENCES "runs"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id");--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_environment_id_environments_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_KualKUh44O1v_fkey" FOREIGN KEY ("github_integration_id") REFERENCES "github_integrations"("id");