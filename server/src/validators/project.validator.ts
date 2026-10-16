import * as z from "zod";

export const createProjectSchema = z.object({
  name: z.string().trim().min(3).max(128),
  repositoryUrl: z.string().trim().max(512).pipe(
      z.httpUrl({
        error: "Invalid repository URL",
      }),
    ),
  repositoryFullName: z.string().trim().min(1).max(256)
    .regex(
      /^[^/\s]+\/[^/\s]+$/,
      "repositoryFullName must be in owner/repository format",
    ),
  defaultBranch: z.string().trim().min(1).max(128),
  pipelinePath: z.string().trim().min(1).max(512).default(".cicd/pipeline.yaml"),
});

export const updateProjectSchema = createProjectSchema
  .pick({name: true,defaultBranch: true,pipelinePath: true})
  .partial() 
  .refine((data) => Object.keys(data).length > 0,{
    message: "At least one field is required to update",
  });

export const projectIdParamSchema = z.object({
  projectId: z.uuid({error: "Invalid project ID"}),
});

export type CreateProject = z.infer<typeof createProjectSchema>;

export type UpdateProject = z.infer<typeof updateProjectSchema>;

export type ProjectIdParam = z.infer<typeof projectIdParamSchema>;