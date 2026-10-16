import {
  pipelineSchema,
  type ValidatedPipeline,
} from "../../validators/pipeline.validator.js";

export type PipelineValidationResult =
  | {
      valid: true;
      pipeline: ValidatedPipeline;
    }
  | {
      valid: false;
      error: string;
    };

const formatValidationIssues = (
  issues: readonly {
    path: PropertyKey[];
    message: string;
  }[],
): string => {
  return issues
    .map((issue) => {
      const path =
        issue.path.length > 0
          ? issue.path
              .map((part) =>
                String(part),
              )
              .join(".")
          : "pipeline";

      return `${path}: ${issue.message}`;
    })
    .join("; ")
    .slice(0, 2_000);
};

export const validatePipeline =
  (
    value: unknown,
  ): PipelineValidationResult => {
    const result =
      pipelineSchema.safeParse(
        value,
      );

    if (!result.success) {
      return {
        valid: false,
        error:
          formatValidationIssues(
            result.error.issues,
          ),
      };
    }

    return {
      valid: true,
      pipeline:
        result.data,
    };
  };