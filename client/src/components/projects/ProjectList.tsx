import { Link } from "react-router-dom";

import {
  ChevronRight,
  FolderGit2,
  GitBranch,
} from "lucide-react";

import type { Project } from "@/types/project";

interface ProjectListProps {
  projects: Project[];
}

export const ProjectList = ({
  projects,
}: ProjectListProps) => {
  if (projects.length === 0) {
    return (
      <div className="rounded-xl border bg-background p-10 text-center">
        <FolderGit2 className="mx-auto size-8 text-muted-foreground" />

        <h3 className="mt-4 font-medium">
          No projects yet
        </h3>

        <p className="mt-1 text-sm text-muted-foreground">
          Create your first project to start running
          pipelines.
        </p>
      </div>
    );
  }

  return (
    <div className="divide-y rounded-xl border bg-background">
      {projects.map((project) => (
        <Link
          key={project.id}
          to={`/projects/${project.id}`}
          className="flex items-center justify-between gap-4 p-5 transition-colors hover:bg-muted/50"
        >
          <div className="min-w-0">
            <h3 className="truncate font-medium">
              {project.name}
            </h3>

            <p className="mt-1 truncate text-sm text-muted-foreground">
              {project.repositoryFullName}
            </p>

            <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <GitBranch className="size-3.5" />
                {project.defaultBranch}
              </span>

              <span className="truncate">
                {project.pipelinePath}
              </span>
            </div>
          </div>

          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </Link>
      ))}
    </div>
  );
};