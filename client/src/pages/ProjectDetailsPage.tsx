import { useState } from "react";

import { Link, useNavigate, useParams } from "react-router-dom";

import { ArrowLeft, Loader2 } from "lucide-react";

import {
  useDeleteProject,
  useProject,
  useUpdateProject,
} from "@/hooks/useProjects";

import { getApiErrorMessage } from "@/lib/api-error";

import { ProjectForm } from "@/components/projects/ProjectForm";
import { DeleteProjectDialog } from "@/components/projects/DeleteProjectDialog";
import { GithubIntegrationCard } from "@/components/projects/GithubIntegrationCard";
import ProjectSecrets from "@/components/projects/ProjectSecrets";
import { buttonVariants, Button } from "@/components/ui/button";

import type { UpdateProjectInput } from "@/types/project";

const ProjectDetailsPage = () => {
  const { projectId } = useParams<{
    projectId: string;
  }>();

  const navigate = useNavigate();

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const {
    data: project,
    isPending,
    isError,
    error,
  } = useProject(projectId ?? "");

  const updateMutation = useUpdateProject(projectId ?? "");

  const deleteMutation = useDeleteProject();

  if (!projectId) {
    return <div className="p-6">Invalid project ID.</div>;
  }

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-8">
        <Link
          to="/projects"
          className={buttonVariants({
            variant: "ghost",
          })}
        >
          <ArrowLeft className="size-4" />
          Projects
        </Link>

        <div className="mt-6 rounded-xl border bg-background p-6">
          <p className="text-sm text-destructive">
            {getApiErrorMessage(error)}
          </p>
        </div>
      </main>
    );
  }

  if (!project) {
    return null;
  }

  const handleUpdate = async (data: UpdateProjectInput) => {
    try {
      await updateMutation.mutateAsync(data);
    } catch {
      // Error is handled by the toast in useUpdateProject.
    }
  };

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync(projectId);

      setDeleteDialogOpen(false);

      navigate("/projects", {
        replace: true,
      });
    } catch {
      // Error is handled by the toast in useDeleteProject.
    }
  };

  return (
    <main className="min-h-screen bg-muted/30">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <Link
          to="/projects"
          className={buttonVariants({
            variant: "ghost",
            className: "-ml-3",
          })}
        >
          <ArrowLeft className="size-4" />
          Projects
        </Link>

        <div className="mt-6">
          <h1 className="text-2xl font-semibold tracking-tight">
            {project.name}
          </h1>

          <p className="mt-1 text-sm text-muted-foreground">
            {project.repositoryFullName}
          </p>
        </div>

        {/* Project Settings */}
        <div className="mt-8 rounded-xl border bg-background p-6">
          <div className="mb-6">
            <h2 className="font-medium">Project settings</h2>

            <p className="mt-1 text-sm text-muted-foreground">
              Update the project configuration used by DeployBench.
            </p>
          </div>

          <ProjectForm
            project={project}
            onSubmit={handleUpdate}
            isPending={updateMutation.isPending}
          />
        </div>

        {/* GitHub Integration */}
        <GithubIntegrationCard projectId={project.id} />
        <ProjectSecrets projectId={project.id} />
        {/* Danger Zone */}
        <div className="mt-8 rounded-xl border border-destructive/30 bg-background p-6">
          <h2 className="font-medium">Danger zone</h2>

          <p className="mt-1 text-sm text-muted-foreground">
            Permanently remove this project from DeployBench.
          </p>

          <Button
            variant="destructive"
            className="mt-4"
            onClick={() => setDeleteDialogOpen(true)}
            disabled={deleteMutation.isPending}
          >
            Delete project
          </Button>
        </div>

        <DeleteProjectDialog
          open={deleteDialogOpen}
          projectName={project.name}
          isPending={deleteMutation.isPending}
          onOpenChange={setDeleteDialogOpen}
          onConfirm={handleDelete}
        />
      </div>
    </main>
  );
};

export default ProjectDetailsPage;
