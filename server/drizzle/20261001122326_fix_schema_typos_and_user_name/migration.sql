ALTER TABLE "webhook_deliveries" RENAME COLUMN "recevied_at" TO "received_at";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "name" varchar(256) NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
DROP TYPE "job_status";--> statement-breakpoint
CREATE TYPE "job_status" AS ENUM('blocked', 'queued', 'running', 'success', 'failed', 'cancelled', 'skipped');--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "status" SET DATA TYPE "job_status" USING "status"::"job_status";--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "status" SET DEFAULT 'blocked'::"job_status";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
DROP TYPE "webhook_status";--> statement-breakpoint
CREATE TYPE "webhook_status" AS ENUM('received', 'queued', 'processing', 'processed', 'failed', 'ignored', 'dead_lettered');--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "status" SET DATA TYPE "webhook_status" USING "status"::"webhook_status";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "status" SET DEFAULT 'received'::"webhook_status";--> statement-breakpoint
ALTER TABLE "github_integrations" ALTER COLUMN "access_token_secret_name" DROP NOT NULL;