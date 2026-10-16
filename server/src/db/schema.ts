import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  uniqueIndex,
  index,
  pgEnum,
  text,
  boolean,
  integer,
  jsonb,
  check,
  foreignKey,
  bigint,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

const timeStamps = {
  createdAt: timestamp("created_at", { withTimezone: true}).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { 
    withTimezone: true,
  }).defaultNow().$onUpdate(() => new Date()).notNull(),
};

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name : varchar("name", {length : 256}).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    ...timeStamps,
  },
  (t) => [
    uniqueIndex("users_email_unique").using("btree", sql`lower(${t.email})`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").references(() => users.id, {onDelete : "cascade"}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("sessions_user_expires_idx").on(t.userId, t.expiresAt),
    index("sessions_expires_idx").on(t.expiresAt), // used for periodic cleanup for expired sessions
  ],
);

export const webhookStatusEnum = pgEnum("webhook_status", [
  "received",
  "queued",
  "processing",
  "processed",
  "failed",
  "ignored",
  "dead_lettered",
]);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }).notNull(),
    githubIntegrationId: uuid("github_integration_id").references(
      () => githubIntegrations.id,
    ).notNull(),
    githubDeliveryId: varchar("github_delivery_id", { length: 128 }).notNull(), // from http-header : X-GitHub-Delivery.
    status: webhookStatusEnum("status").default("received").notNull(),
    eventName: varchar("event_name", { length: 64 }).notNull(), //  from http-header : X-GitHub-Event
    ref: varchar("ref", { length: 512 }),
    isForced: boolean("is_forced").notNull(),
    isDeleted: boolean("is_deleted").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    beforeSha: varchar("before_sha", { length: 256 }).notNull(), // SHA of the most recent commit on ref before the push.
    afterSha: varchar("after_sha", { length: 256 }).notNull(), // SHA of the most recent commit on ref after the push.
    lastError: text("last_error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
    ...timeStamps
  },
  (t) => [
    uniqueIndex("webhook_deliveries_integration_delivery_unique").on(
      t.githubIntegrationId,
      t.githubDeliveryId,
    ),
    index("webhook_deliveries_status_retry_idx").on(t.status, t.nextAttemptAt),
    index("webhook_deliveries_project_received_idx").on(t.projectId, t.receivedAt),
    check(
      "webhook_deliveries_attempt_count_check",
      sql`${t.attemptCount} >= 0`,
    ),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 128 }).notNull(),
    slug: varchar("slug", { length: 120 }).notNull(),
    repositoryUrl: varchar("repository_url", { length: 512 }).notNull(),
    repositoryFullName: varchar("repository_full_name", {
      length: 256,
    }).notNull(),
    defaultBranch: varchar("default_branch", { length: 128 }).notNull(),
    pipelinePath: varchar("pipeline_path", { length: 512 })
      .default(".cicd/pipeline.yaml")
      .notNull(),
    createdById: uuid("created_by_id")
      .references(() => users.id, {onDelete : "cascade"}).notNull(),
    ...timeStamps,
  },
  (t) => [
    uniqueIndex("projects_slug_unique").using("btree", sql`lower(${t.slug})`),
    uniqueIndex("projects_repository_full_name_unique").using(
      "btree",
      sql`lower(${t.repositoryFullName})`,
    ),
    index("projects_created_by_idx").on(t.createdById),
  ],
);

export const githubIntegrations = pgTable(
  "github_integrations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    repositoryFullName : varchar("repository_full_name", {length : 256}).notNull(),
    // AES-GCM encrypted webhook secret.
    webhookSecretCiphertext: text("webhook_secret_cipher_text").notNull(),
    webhookSecretIv: varchar("webhook_secret_iv", { length: 128 }).notNull(),
    webhookSecretAuthTag: varchar("webhook_secret_auth_tag", {
      length: 128,
    }).notNull(),
    accessTokenSecretName: varchar("access_token_secret_name", {
      length: 128,
    }),
    enabled: boolean("enabled").default(true).notNull(),
    ...timeStamps,
  },
  (t) => [
    uniqueIndex("github_integrations_project_unique").on(t.projectId),
  ],
);

export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 128 }).notNull(),
    projectId: uuid("project_id").references(() => projects.id, {onDelete : "cascade"}),
    environmentId: uuid("environment_id").references(() => environments.id, {onDelete : "cascade"}),
    cipherText: text("cipher_text").notNull(),
    iv: varchar("iv", { length: 128 }).notNull(),
    authTag: varchar("auth_tag", { length: 128 }).notNull(),
    ...timeStamps,
  },
  (t) => [
    // NOTE : secret name is case-sensitive
    // Project-scoped secret names are unique inside the project.
    uniqueIndex("secrets_name_in_project_unique").on(t.projectId, t.name),
    // Environment-scoped secret names are unique inside the environment.
    uniqueIndex("secrets_name_in_environment_unique").on(
      t.environmentId,
      t.name,
    ),
    check(
      "secrets_exactly_one_scope_check",
      sql`(
      (${t.projectId} IS NOT NULL AND ${t.environmentId} IS NULL)
      OR
     (${t.projectId} IS NULL AND ${t.environmentId} IS NOT NULL)
     )`,
    ),
  ],
);

export const deploymentTargetTypeEnum = pgEnum("deployment_target_type", [
  "ssh_ec2",
  "s3",
]);

export const environments = pgTable(
  "environments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }).notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    slug: varchar("slug", { length: 128 }).notNull(),
    targetType: deploymentTargetTypeEnum("target_type").notNull(),
    targetConfig: jsonb("target_config")
      .$type<Record<string, unknown>>()
      .notNull(),
    deploymentBranch: varchar("deployment_branch", { length: 128 }).notNull(),
    // not required for frontend static builds
    // required for backend builds
    healthCheckUrl: text("health_check_url"),
    healthCheckTimeoutSeconds: integer("health_check_timeout_seconds")
      .default(30)
      .notNull(),
    // Desired state.
    // Application sets this to the successful run that has been selected for deployment.
    // A commit can have several runs (manual / retry), so store the chosen run too.
    desiredRunId: uuid("desired_run_id").references(() => runs.id, { onDelete: "set null" }),
    desiredCommitSha: varchar("desired_commit_sha", { length: 128 }),
    // Actually deployed commit
    currentCommitSha: varchar("current_commit_sha", { length: 128 }),
    currentReleaseRef: varchar("current_release_ref", { length: 128 }),
    currentImageId: uuid("current_image_id").references(
      () => containerImages.id,
      { onDelete: "set null" },
    ),
    currentArtifactId: uuid("current_artifact_id").references(
      () => artifacts.id,
      { onDelete: "set null" },
    ),
    ...timeStamps,
  },
  (t) => [
    uniqueIndex("environments_project_id_slug_unique").on(t.projectId, t.slug),
    index("environments_project_idx").on(t.projectId),
    index("environments_desired_idx").on(t.projectId, t.desiredCommitSha),
    check(
      "environments_health_timeout_check",
      sql`${t.healthCheckTimeoutSeconds} > 0`,
    ),
    check(
      "environments_current_target_check",
      sql`
        (
          ${t.targetType} = 'ssh_ec2'
          AND ${t.currentArtifactId} IS NULL
        )
        OR
        (
          ${t.targetType} = 's3'
          AND ${t.currentImageId} IS NULL
        )
      `,
    ),
    // backend (ssh_ec2) deployments must be health-checked 
   check("environments_backend_health_check_required",
   sql`${t.targetType} <> 'ssh_ec2' OR ${t.healthCheckUrl} IS NOT NULL`,
  ),
  ],
);

export const pipelineValidationStatusEnum = pgEnum(
  "pipeline_validation_status",
  ["valid", "invalid"],
);

export const pipelineVersions = pgTable(
  "pipeline_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, {
        onDelete: "cascade",
      })
      .notNull(),
    path: varchar("path", { length: 512 }).notNull(),
    configHash: varchar("config_hash", { length: 128 }).notNull(),
    commitSha: varchar("commit_sha", { length: 128 }).notNull(),
    rawYaml: text("raw_yaml").notNull(),
    normalizedYaml: jsonb("normalized_yaml").$type<Record<string, unknown>>(),
    validationStatus:
      pipelineValidationStatusEnum("validation_status").notNull(),
    validationError: text("validation_error"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("pipeline_versions_project_commit__path_unique").on(
      t.projectId,
      t.commitSha,
      t.path
    ),
    index("pipeline_versions_project_idx").on(t.projectId),
    check(
      "pipeline_versions_validation_consistency_check",
      sql`
        (
          ${t.validationStatus} = 'valid'
          AND ${t.normalizedYaml} IS NOT NULL
          AND ${t.validationError} IS NULL
        )
        OR
        (
          ${t.validationStatus} = 'invalid'
          AND ${t.normalizedYaml} IS NULL
          AND ${t.validationError} IS NOT NULL
        )
      `,
    ),
  ],
);

// latest known branch state, table is used for the "latest commit wins" policy.
export const branchHeads = pgTable(
  "branch_heads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    branch: varchar("branch", { length: 128 }).notNull(),
    commitSha: varchar("commit_sha", { length: 128 }).notNull(),
    isDeleted: boolean("is_deleted").default(false).notNull(),
    sourceWebhookDeliveryId: uuid("source_webhook_delivery_id").references(
      () => webhookDeliveries.id,
      { onDelete: "set null" },
    ),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    ...timeStamps,
  },
  (t) => [
    uniqueIndex("branch_heads_project_id_branch").on(t.projectId, t.branch),
    index("branch_heads_project_idx").on(t.projectId),
  ],
);

export const runStatusEnum = pgEnum("run_status", [
  "queued",
  "running",
  "success",
  "failed",
  "cancelled",
  "superseded",
]);

export const runTriggerEnum = pgEnum("run_trigger", [
  "push",
  "manual",
  "retry",
]);

// Lifecycle of an entire pipeline run.
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .references(() => projects.id, {
        onDelete: "cascade",
      })
      .notNull(),
    pipelineVersionId: uuid("pipeline_version_id")
      .references(() => pipelineVersions.id)
      .notNull(),
    webhookDeliveryId: uuid("webhook_delivery_id").references(
      () => webhookDeliveries.id,
      { onDelete: "set null" },
    ),
    commitSha: varchar("commit_sha", { length: 128 }).notNull(),
    branch: varchar("branch", { length: 128 }).notNull(),
    status: runStatusEnum("status").default("queued").notNull(),
    trigger: runTriggerEnum("trigger").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    ...timeStamps,
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededByRunId: uuid("superseded_by_run_id").references(
      (): AnyPgColumn => runs.id,
      {
        onDelete: "set null",
      },
    ), //self referencing
    errorCode: varchar("error_code", { length: 128 }),
    errorMessage: text("error_message"),
  },
  (t) => [
    uniqueIndex("runs_webhook_delivery_unique").on(t.webhookDeliveryId),
    index("runs_project_created_idx").on(t.projectId, t.createdAt),
    index("runs_project_branch_created_idx").on(
      t.projectId,
      t.branch,
      t.createdAt,
    ),
    index("runs_status_idx").on(t.status),
    index("runs_project_commit_idx").on(t.projectId, t.commitSha),
  ],
);

// Lifecycle of a logical job.
export const jobStatusEnum = pgEnum("job_status", [
  "blocked",
  "queued",
  "running",
  "success",
  "failed",
  "cancelled",
  "skipped",
]);

// Logical schedulable unit inside a run. and Physical retries are stored in job_attempts.
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .references(() => runs.id, { onDelete: "cascade" })
      .notNull(),
    key: varchar("key", { length: 120 }).notNull(), // for machine readable
    name: varchar("name", { length: 128 }).notNull(), // for human readable
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    status: jobStatusEnum("status").default("blocked").notNull(),
    allowFailure: boolean("allow_failure").default(false).notNull(), //If true, a failed job does not fail the whole run
    errorCode: varchar("error_code", {
      length: 100,
    }),
    errorMessage: text("error_message"),
    timeoutSeconds: integer("timeout_seconds").default(3600).notNull(),
    maxAttempts: integer("max_attempts").default(1).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timeStamps,
  },
  (t) => [
    // Job key must be unique inside a run.
    uniqueIndex("jobs_run_id_key_unique").on(t.runId, t.key),
    uniqueIndex("jobs_run_id_id_unique").on(t.runId, t.id),
    index("jobs_run_status_idx").on(t.runId, t.status),
    index("jobs_status_next_attempt_at_idx").on(t.status, t.nextAttemptAt),
    check("jobs_timeout_check", sql`${t.timeoutSeconds} > 0`),
    check(
      "jobs_max_attempts_check",
      sql`${t.maxAttempts} >= 1 AND ${t.maxAttempts} <= 5`,
    ),
  ],
);

// DAG edges between jobs belonging to the same run.
export const jobDependencies = pgTable(
  "job_dependencies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .references(() => runs.id, { onDelete: "cascade" })
      .notNull(),
    jobId: uuid("job_id")
      .references(() => jobs.id, { onDelete: "cascade" })
      .notNull(),
    dependsOnJobId: uuid("depends_on_job_id").references(() => jobs.id, {
      onDelete: "cascade",
    }).notNull(),
  },
  (t) => [
    uniqueIndex("job_dependencies_unique").on(t.jobId, t.dependsOnJobId),
    index("job_dependencies_depends_on_job_id_idx").on(t.dependsOnJobId),
    foreignKey({
      name: "job_dependencies_job_same_run_fk",
      columns: [t.runId, t.jobId],
      foreignColumns: [jobs.runId, jobs.id],
    }),
    foreignKey({
      columns: [t.runId, t.dependsOnJobId],
      foreignColumns: [jobs.runId, jobs.id],
      name: "job_dependencies_dependency_same_run_fk",
    }),
    check(
      "job_dependencies_not_self_check",
      sql`${t.jobId} <> ${t.dependsOnJobId}`,
    ),
  ],
);

// Lifecycle of one physical execution attempt of a job.
export const jobAttemptStatusEnum = pgEnum("job_attempt_status", [
  "queued",
  "running",
  "success",
  "failed",
  "cancelled",
  "timed_out",
]);

// Classification of an execution failure.
export const failureClassEnum = pgEnum("failure_class", [
  "configuration",
  "user_code",
  "dependency",
  "infrastructure",
  "timeout",
  "authorization",
  "cancelled",
  "unknown",
]);
// One physical execution of a logical job.
export const jobAttempts = pgTable(
  "job_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id")
      .references(() => jobs.id, { onDelete: "cascade" })
      .notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    status: jobAttemptStatusEnum("status").default("queued").notNull(),
    queueName: varchar("queue_name", { length: 120 }).notNull(), // bullmq queue name
    queueJobId: varchar("queue_job_id", { length: 255 }),
    // Lease token for worker ownership.
    leaseToken: varchar("lease_token", { length: 128 }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
    }),
    failureClass: failureClassEnum("failure_class"),
    retryable: boolean("retryable"),
    stepResults: jsonb("step_results").$type<Record<string, unknown>[]>(),
    startedAt: timestamp("started_at", {
      withTimezone: true,
    }),
    // process/container exit status
    containerId: varchar("container_id", {
      length: 256,
    }),
    exitCode: integer("exit_code"),
    errorCode: varchar("error_code", {
      length: 128,
    }),
    errorMessage: text("error_message"),
    finishedAt: timestamp("finished_at", {
      withTimezone: true,
    }),
    ...timeStamps,
  },
  (t) => [
    uniqueIndex("job_attempts_job_id_attempt_number_unique").on(
      t.jobId,
      t.attemptNumber,
    ),
    uniqueIndex("job_attempts_lease_token_unique").on(t.leaseToken),
    uniqueIndex("job_attempts_queue_job_unique").on(t.queueName, t.queueJobId),
    index("job_attempts_status_heartbeat_idx").on(t.status, t.heartbeatAt),
    index("job_attempts_lease_idx").on(t.status, t.leaseExpiresAt),
    check("job_attempts_attempt_number_check", sql`${t.attemptNumber} >= 1`),
  ],
);

// Lifecycle of an artifact.
export const artifactStatusEnum = pgEnum("artifact_status", [
  "uploading",
  "ready",
  "failed",
  "expired",
  "deleted",
]);

export const artifactKindEnum = pgEnum("artifact_kind", [
  "archive",
  "file",
]);

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .references(() => runs.id, { onDelete: "cascade" })
      .notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    kind: artifactKindEnum("kind").default("archive").notNull(),
    contentType: varchar("content_type",{ length: 255}),
    producerJobId: uuid("producer_job_id").references(() => jobs.id, {
      onDelete: "set null",
    }),
    producerJobAttemptId: uuid("producer_job_attempt_id").references(
      () => jobAttempts.id,
      { onDelete: "set null" },
    ),
    status: artifactStatusEnum("status").default("uploading").notNull(),
    sha256: varchar("sha256", { length: 64 }), // null while uploading
    s3BucketName: varchar("s3_bucket_name", { length: 128 }).notNull(),
    // prefix pattern : projects/{projectId}/runs/{runId}/artifacts/{artifactId}-{sanitizedName}
    objectKey: text("object_key").notNull(),
    sizeInBytes: bigint("size_in_bytes", { mode: "number" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("artifacts_run_id_name").on(t.runId, t.name),
    index("artifacts_status_expiry_idx").on(t.status, t.expiresAt),
    index("artifacts_run_idx").on(t.runId),
    check("artifacts_size_check", sql`${t.sizeInBytes} >= 0`),
  ],
);

export const containerImages = pgTable(
  "container_images",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    runId: uuid("run_id")
      .references(() => runs.id, { onDelete: "cascade" })
      .notNull(),
    tag: varchar("tag", { length: 128 }).notNull(), // tag strategy :- run-<runId>
    digest: varchar("digest", { length: 128 }).notNull(), // ECR digest, ex : sha256:abc123.
    producerJobId: uuid("producer_job_id").references(() => jobs.id, {
      onDelete: "set null",
    }),
    producerJobAttemptId: uuid("producer_job_attempt_id").references(
      () => jobAttempts.id,
      { onDelete: "set null" },
    ),
    registry: varchar("registry", { length: 255 }).notNull(), // ECR registry
    repository: varchar("repository", { length: 256 }).notNull(), // ECR respository
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("container_images_registry_repository_tag_unique").on(
      t.registry,
      t.repository,
      t.tag,
    ),
    index("container_images_repository_idx").on(t.repository, t.tag),
    index("container_images_run_idx").on(t.runId),
  ],
);

export const deploymentActionEnum = pgEnum("deployment_action", [
  "deploy",
  "rollback",
]);


export const deploymentStatusEnum = pgEnum("deployment_status", [
  "queued",
  "deploying",
  "verifying",
  "success",
  "failed",
  "cancelled",
  "superseded",
]);

export const deployments = pgTable("deployments",{
  id : uuid("id").defaultRandom().primaryKey(),
  runId : uuid("run_id").references(() => runs.id,{onDelete : "set null"}),
  environmentId : uuid("environment_id").references(() => environments.id, {
    onDelete : "cascade"
  }).notNull(),
  rollbackToDeploymentId: uuid("rollback_to_deployment_id")
  .references((): AnyPgColumn => deployments.id,{
        onDelete: "set null",
      },
    ),
  containerImageId : uuid("container_image_id").references(() => containerImages.id, {
    onDelete : "set null"
  }),
  artifactId : uuid("artifact_id").references(() => artifacts.id, {
    onDelete : "set null"
  }),
  action : deploymentActionEnum("action").notNull(),
  status : deploymentStatusEnum("status").default("queued").notNull(),
  commitSha: varchar("commit_sha",{length:128}).notNull(),// Commit this deployment is attempting to deploy/restore
  previousCommitSha: varchar("previous_commit_sha",{length:128}), // Commit actually deployed immediately before this deployment began
  // releaseref points to physical address of our deployable artifact, containerimage or any other asset
  releaseRef : varchar("release_ref",{length : 512}).notNull(), // // Exact release this deployment is attempting to deploy/restore.
  previousReleaseRef: varchar("previous_release_ref",{length: 512}),// Exact release actually deployed immediately before this deployment began.
  errorCode: varchar("error_code", { length: 128 }),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }),  
  finishedAt: timestamp("finished_at", { withTimezone: true }), 
  ...timeStamps,
},(t) => [
  uniqueIndex("deployments_one_active_per_env")
  .on(t.environmentId)
  .where(sql`${t.status} IN ('queued', 'deploying', 'verifying')`),
  index("deployments_environment_id__created_at_idx").on(t.environmentId,t.createdAt),
  uniqueIndex("deployments_run_environment_unique")
  .on(t.runId, t.environmentId)
  .where(sql`${t.status} NOT IN ('failed','cancelled')`),
  index("deployments_run_id_idx").on(t.runId),
  // using partial index to optimize, since most of the deployments have rollbackToDeploymentId NULL
  // index("deployments_rollback_to_deployment_id_idx").on(t.rollbackToDeploymentId)
  // .where(sql`${t.rollbackToDeploymentId} IS NOT NULL`),
  index("deployments_rollback_to_deployment_id_idx").on(t.rollbackToDeploymentId),
  // Rollback must point to a previous deployment
  // Normal deployment must not contain a rollback target,
  check(
  "deployments_deploy_requires_run",
  sql`${t.action} <> 'deploy' OR ${t.runId} IS NOT NULL`,
),
   check(
      "deployments_rollback_target_check",
      sql`
        (
          ${t.action} = 'rollback'
          AND
          ${t.rollbackToDeploymentId} IS NOT NULL
        )
        OR
        (
          ${t.action} = 'deploy'
          AND
          ${t.rollbackToDeploymentId} IS NULL
        )
      `,
    )
])

// naming pattern : projects/{projectId}/runs/{runId}/attempts/{jobAttemptId}/logs/{stream}/
// projects/P1/runs/R1/attempts/A1/logs/stdout/000000.log
// projects/P1/runs/R1/attempts/A1/logs/stdout/000001.log

// Logical log streams produced by a job attempt. 
export const logStreamTypeEnum = pgEnum("log_stream_type", [
  "stdout",
  "stderr",
  "system",
]);

// Lifecycle of a log stream.
export const logStreamStatusEnum = pgEnum("log_stream_status", [
  "open",
  "completed",
  "failed",
]);

export const logStreams = pgTable("log_streams",{
  id : uuid("id").defaultRandom().primaryKey(),
  jobAttemptId: uuid( "job_attempt_id").references(() => jobAttempts.id,{
    onDelete: "cascade"
  }).notNull(),
  streamType : logStreamTypeEnum("stream_type").notNull(),
  status: logStreamStatusEnum("status").default("open").notNull(),
  s3Bucket: varchar("s3_bucket", { length: 256 }).notNull(),
  // Prefix containing the chunks for this stream.
  s3Prefix: text("s3_prefix").notNull(),
  totalBytes: bigint("total_bytes", { mode: "number"}).default(0).notNull(),
  totalLines: bigint("total_lines", { mode: "number"}).default(0).notNull(),
  lastSequence: integer("last_sequence").default(-1).notNull(), // starts at -1 before first chunk
  createdAt: timestamp("created_at", { withTimezone: true}).defaultNow().notNull(),
  closedAt: timestamp("closed_at",{ withTimezone: true }),
},(t) => [
  uniqueIndex("log_streams_job_attempt_stream_type_unique").on(t.jobAttemptId,t.streamType),
  check("log_streams_last_sequence_check",sql`${t.lastSequence} >= -1`),
])

export const logChunks = pgTable("log_chunks",{
  id: bigint("id",{mode : "number"}).generatedAlwaysAsIdentity().primaryKey(),
  logStreamId: uuid("log_stream_id").references(() => logStreams.id,{
      onDelete: "cascade",
      }).notNull(),
  sizeInBytes : integer("size_in_bytes").notNull(),
  s3Key: text("s3_key").notNull(),
  sequence: integer("sequence").notNull(),
  lineCount: integer("line_count").notNull(),
  sha256: varchar("sha256",{ length: 128}).notNull(),
  firstTimestamp: timestamp("first_timestamp",{ withTimezone: true}),
  lastTimestamp: timestamp("last_timestamp",{ withTimezone: true}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
},(t) => [
  uniqueIndex("log_chunks_stream_sequence_unique").on(t.logStreamId,t.sequence),
  uniqueIndex("log_chunks_s3_key_unique").on(t.s3Key),
  check("log_chunks_sequence_check",sql`${t.sequence} >= 0`),
  check("log_chunks_size_check",sql`${t.sizeInBytes} >= 0`),
  check("log_chunks_line_count_check",sql`${t.lineCount} >= 0`)
])


// Lifecycle of an outbox message.
export const outboxStatusEnum = pgEnum("outbox_status", [
  "pending",
  "publishing",
  "published",
  "failed",
  "dead_lettered",
]);

export const outboxMessages = pgTable("outbox_messages",{
  id : uuid("id").defaultRandom().primaryKey(),
  messageType: varchar("message_type",{ length: 120}).notNull(),
  aggregateType: varchar("aggregate_type",{ length: 64 }).notNull(),
  aggregateId: varchar("aggregate_id",{ length: 128 }).notNull(),
  dedupeKey: varchar("dedupe_key",{ length: 255 }).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(), 
  queueName: varchar("queue_name", { length: 120 }).notNull(),
  status: outboxStatusEnum("status").default("pending").notNull(),
  attemptCount: integer("attempt_count").default(0).notNull(), 
  availableAt: timestamp("available_at",{withTimezone: true}).defaultNow().notNull(),
  leaseToken: varchar("lease_token",{ length: 128 }), 
  leaseExpiresAt: timestamp("lease_expires_at",{ withTimezone: true }), 
  lastError: text("last_error"),
  publishedAt: timestamp("published_at",{ withTimezone: true}),
  ...timeStamps,
},(t) => [
   uniqueIndex("outbox_dedupe_key_unique").on(t.dedupeKey),
    index("outbox_status_available_idx").on(t.status,t.availableAt),
    index("outbox_publishing_lease_idx").on(t.status,t.leaseExpiresAt),
    check("outbox_attempt_count_check",sql`${t.attemptCount} >= 0`),
])


 // Lifecycle of a persistent dead-letter record.
export const deadLetterStatusEnum = pgEnum("dead_letter_status", [
  "open",
  "replayed",
  "resolved",
  "discarded",
]);

export const deadLetters = pgTable("dead_letters",{
  id : uuid("id").defaultRandom().primaryKey(),
  status: deadLetterStatusEnum("status").default("open").notNull(),
  sourceType: varchar("source_type",{ length: 64 }).notNull(),
  sourceId: varchar("source_id", { length: 128}).notNull(),
  queueName: varchar("queue_name", { length: 120 }),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  attempts: integer("attempts").default(0).notNull(),
  replayCount: integer("replay_count").default(0).notNull(),
  failureClass: failureClassEnum("failure_class"),
  errorCode: varchar("error_code", { length: 128 }), 
  errorMessage: text("error_message").notNull(),
  firstFailedAt: timestamp("first_failed_at",{ withTimezone: true}).defaultNow().notNull(), 
  lastFailedAt: timestamp("last_failed_at",{ withTimezone: true}).defaultNow().notNull(),
  replayedAt: timestamp("replayed_at",{ withTimezone: true }),
  resolvedAt: timestamp("resolved_at",{ withTimezone: true }),
  ...timeStamps,
},(t) => [
  uniqueIndex("dead_letters_source_unique").on(t.sourceType, t.sourceId),
  index("dead_letters_status_created_idx",).on(t.status,t.createdAt),
  check("dead_letters_attempts_check",sql`${t.attempts} >= 0`),
  check("dead_letters_replay_count_check",sql`${t.replayCount} >= 0`),
])