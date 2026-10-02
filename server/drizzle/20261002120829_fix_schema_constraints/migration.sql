ALTER TABLE "webhook_deliveries" RENAME COLUMN "attempted_at" TO "last_attempt_at";--> statement-breakpoint
ALTER TABLE "deployments" ALTER COLUMN "previous_commit_sha" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "environments" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "job_dependencies" ALTER COLUMN "depends_on_job_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "log_chunks" ALTER COLUMN "size_in_bytes" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_created_by_id_users_id_fkey", ADD CONSTRAINT "projects_created_by_id_users_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "secrets" DROP CONSTRAINT "secrets_project_id_projects_id_fkey", ADD CONSTRAINT "secrets_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "secrets" DROP CONSTRAINT "secrets_environment_id_environments_id_fkey", ADD CONSTRAINT "secrets_environment_id_environments_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE;