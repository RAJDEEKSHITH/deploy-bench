import { useNavigate } from "react-router-dom";

import { Loader2 } from "lucide-react";

import {
  useProjects,
} from "@/hooks/useProjects";

import { getApiErrorMessage } from "@/lib/api-error";

import { CreateProjectDialog } from "@/components/projects/CreateProjectDialog";
import { ProjectList } from "@/components/projects/ProjectList";

const ProjectsPage = () => {
  const navigate = useNavigate();

  const {
    data: projects = [],
    isPending,
    isError,
    error,
  } = useProjects();

  return (
    <main className="min-h-screen bg-muted/30">
      <div className="mx-auto max-w-7xl px-6 py-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Projects
            </h1>

            <p className="mt-1 text-sm text-muted-foreground">
              Manage repositories connected to DeployBench.
            </p>
          </div>

          <CreateProjectDialog
            onCreated={(projectId) => {
              navigate(`/projects/${projectId}`);
            }}
          />
        </div>

        <section className="mt-8">
          {isPending && (
            <div className="flex min-h-48 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {isError && (
            <div className="rounded-xl border border-destructive/30 bg-background p-6">
              <p className="text-sm text-destructive">
                {getApiErrorMessage(error)}
              </p>
            </div>
          )}

          {!isPending && !isError && (
            <ProjectList projects={projects} />
          )}
        </section>
      </div>
    </main>
  );
};

export default ProjectsPage;