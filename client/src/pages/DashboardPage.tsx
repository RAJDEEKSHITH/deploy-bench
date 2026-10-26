import { Link, useNavigate } from "react-router-dom";
import { FolderGit2, GitBranch, Loader2 } from "lucide-react";

import { useProjects } from "@/hooks/useProjects";
import { CreateProjectDialog } from "@/components/projects/CreateProjectDialog";
import { ProjectList } from "@/components/projects/ProjectList";
import { buttonVariants } from "@/components/ui/button";

const DashboardPage = () => {
  const navigate = useNavigate();
  const { data: projects = [], isPending } = useProjects();

  return (
    <main className="min-h-full bg-muted/30">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 space-y-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Dashboard
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Monitor your connected repositories, pipeline runs, and deployments.
            </p>
          </div>

          <CreateProjectDialog
            onCreated={(projectId) => {
              navigate(`/projects/${projectId}`);
            }}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-xl border bg-background p-5">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                Total Projects
              </span>
              <FolderGit2 className="size-4 text-muted-foreground" />
            </div>
            <p className="mt-2 text-2xl font-semibold">
              {isPending ? "—" : projects.length}
            </p>
          </div>

          <div className="rounded-xl border bg-background p-5">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                Active Branches
              </span>
              <GitBranch className="size-4 text-muted-foreground" />
            </div>
            <p className="mt-2 text-2xl font-semibold">
              {isPending
                ? "—"
                : new Set(projects.map((p) => p.defaultBranch)).size}
            </p>
          </div>
        </div>

        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Your projects</h2>
            <Link
              to="/projects"
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              View all
            </Link>
          </div>

          {isPending ? (
            <div className="flex min-h-40 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <ProjectList projects={projects.slice(0, 5)} />
          )}
        </section>
      </div>
    </main>
  );
};

export default DashboardPage;