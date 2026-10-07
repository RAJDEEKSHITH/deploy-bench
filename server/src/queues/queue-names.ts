export const QUEUE_NAMES = {
  webhook: "webhook",
  jobAttempt: "job-attempt",
  deployment: "deployment",
} as const;

export type QueueName =
  (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const JOB_NAMES = {
  githubWebhook: "github.webhook.received",
  jobAttempt: "job-attempt.execute",
  deployment: "deployment.execute",
} as const;