export interface Project {
  id: string;
  name: string;
  slug: string;
  repositoryUrl: string;
  repositoryFullName: string;
  defaultBranch: string;
  pipelinePath: string;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  repositoryUrl: string;
  repositoryFullName: string;
  defaultBranch: string;
  pipelinePath?: string;
}

export interface UpdateProjectInput {
  name?: string;
  defaultBranch?: string;
  pipelinePath?: string;
}

export interface ProjectResponse {
  success: boolean;
  message: string;
  data: {
    project: Project;
  };
}

export interface ProjectsResponse {
  success: boolean;
  message: string;
  data: {
    projects: Project[];
  };
}