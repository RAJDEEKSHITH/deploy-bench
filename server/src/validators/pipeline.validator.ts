import * as z from "zod";

const JOB_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/; // jobs.key is varchar(120)

const MAX_JOBS = 100;
const MAX_COMMANDS_PER_JOB = 100;
const MAX_COMMAND_LENGTH = 10_000;
const MAX_DEPENDENCIES_PER_JOB = 100;
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;

const jobKeySchema = z
  .string()
  .regex(
    JOB_KEY_PATTERN,
    "Job key must start with a letter or number, contain only letters, numbers, '.', '_' or '-', and be at most 120 characters",
  );

const nonBlankString = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, "Value must not be blank");

export const pipelineJobSchema = z.strictObject({
  // Optional: the normalizer derives it from the job key.
  name: nonBlankString(128).optional(),
  commands: z.array(nonBlankString(MAX_COMMAND_LENGTH)).min(1).max(MAX_COMMANDS_PER_JOB),
  dependsOn: z.array(jobKeySchema).max(MAX_DEPENDENCIES_PER_JOB).default([]),
  // jobs.timeout_seconds > 0 (Zod's int() already guarantees a safe integer)
  timeoutSeconds: z.number().int().positive().max(MAX_TIMEOUT_SECONDS).default(3600),
  // jobs.max_attempts: 1..5
  maxAttempts: z.number().int().min(1).max(5).default(1),
  allowFailure: z.boolean().default(false),
});

export const pipelineSchema = z
  .strictObject({
    jobs: z.record(jobKeySchema, pipelineJobSchema).refine((jobs) => {
      const count = Object.keys(jobs).length;
      return count >= 1 && count <= MAX_JOBS;
    }, `Pipeline must define between 1 and ${MAX_JOBS} jobs`),
  })
  .superRefine((pipeline, ctx) => {
    const jobs = new Map(Object.entries(pipeline.jobs));

    // 1. Dependency references: duplicates, self-dependencies, unknown jobs.
    for (const [jobKey, job] of jobs) {
      const seen = new Set<string>();

      for (const [index, dependencyKey] of job.dependsOn.entries()) {
        const path = ["jobs", jobKey, "dependsOn", index];

        if (seen.has(dependencyKey)) {
          ctx.addIssue({ code: "custom", path, message: `Duplicate dependency "${dependencyKey}"` });
          continue;
        }
        seen.add(dependencyKey);

        if (dependencyKey === jobKey) {
          ctx.addIssue({ code: "custom", path, message: "A job cannot depend on itself" });
        } else if (!jobs.has(dependencyKey)) {
          ctx.addIssue({ code: "custom", path, message: `Dependency "${dependencyKey}" does not exist` });
        }
      }
    }

    // 2. The graph must be a DAG, otherwise a run would block forever.
    const state = new Map<string, "visiting" | "done">();
    const stack: string[] = [];

    const findCycle = (jobKey: string): string[] | null => {
      state.set(jobKey, "visiting");
      stack.push(jobKey);

      for (const dependencyKey of jobs.get(jobKey)?.dependsOn ?? []) {
        // Self/unknown dependencies were already reported above.
        if (dependencyKey === jobKey || !jobs.has(dependencyKey)) continue;

        if (state.get(dependencyKey) === "visiting") {
          return [...stack.slice(stack.indexOf(dependencyKey)), dependencyKey];
        }
        if (!state.has(dependencyKey)) {
          const cycle = findCycle(dependencyKey);
          if (cycle) return cycle;
        }
      }

      stack.pop();
      state.set(jobKey, "done");
      return null;
    };

    for (const jobKey of jobs.keys()) {
      if (state.has(jobKey)) continue;

      const cycle = findCycle(jobKey);
      if (cycle) {
        ctx.addIssue({
          code: "custom",
          path: ["jobs"],
          message: `Dependency cycle detected: ${cycle.join(" -> ")}`,
        });
        break;
      }
    }
  });

export type ValidatedPipeline = z.output<typeof pipelineSchema>;