import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ChevronRight,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  Play,
} from "lucide-react";

import { useProjectRuns, useTriggerManualRun } from "@/hooks/useRuns";
import { getApiErrorMessage } from "@/lib/api-error";
import type { RunStatus } from "@/types/run";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface ProjectRunsSectionProps {
  projectId: string;
  defaultBranch: string;
}

const getStatusBadgeClasses = (status: RunStatus): string => {
  switch (status) {
    case "success":
      return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20";
    case "running":
      return "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20";
    case "queued":
      return "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20";
    case "failed":
      return "bg-destructive/10 text-destructive border-destructive/20";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
};

export const ProjectRunsSection = ({
  projectId,
  defaultBranch,
}: ProjectRunsSectionProps) => {
  const navigate = useNavigate();
  const {
    data: runs = [],
    isPending,
    isError,
    error,
  } = useProjectRuns(projectId);

  const triggerMutation = useTriggerManualRun(projectId);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [branch, setBranch] = useState(defaultBranch);
  const [commitSha, setCommitSha] = useState("");
  const [rawYaml, setRawYaml] = useState("");

  const handleTrigger = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const response = await triggerMutation.mutateAsync({
        ...(branch.trim() ? { branch: branch.trim() } : {}),
        ...(commitSha.trim() ? { commitSha: commitSha.trim() } : {}),
        ...(rawYaml.trim() ? { rawYaml: rawYaml.trim() } : {}),
      });
      setDialogOpen(false);
      navigate(`/projects/${projectId}/runs/${response.data.run.id}`);
    } catch {
      // Handled by mutation toast
    }
  };

  return (
    <section className="mt-8 rounded-xl border bg-background">
      <div className="flex flex-col gap-4 border-b p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-medium">Pipeline runs</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Trigger manual pipeline runs or inspect webhook-triggered executions.
          </p>
        </div>

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger render={<Button />}>
            <Play className="size-4" />
            Trigger run
          </DialogTrigger>

          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Trigger manual pipeline run</DialogTitle>
              <DialogDescription>
                Start a new run on a branch. Leave commit SHA or YAML blank to use defaults.
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={handleTrigger} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="run-branch">Branch</Label>
                <Input
                  id="run-branch"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder={defaultBranch}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="run-commit-sha">Commit SHA (optional)</Label>
                <Input
                  id="run-commit-sha"
                  value={commitSha}
                  onChange={(e) => setCommitSha(e.target.value)}
                  placeholder="e.g. a1b2c3d4e5f6..."
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="run-yaml">Custom pipeline YAML (optional)</Label>
                <Textarea
                  id="run-yaml"
                  value={rawYaml}
                  onChange={(e) => setRawYaml(e.target.value)}
                  placeholder={`jobs:\n  build:\n    name: Build & Test\n    commands:\n      - npm ci\n      - npm run build`}
                  className="min-h-32 font-mono text-xs"
                />
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={triggerMutation.isPending}>
                  {triggerMutation.isPending && (
                    <Loader2 className="size-4 animate-spin" />
                  )}
                  Start run
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {isPending && (
        <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading runs...
        </div>
      )}

      {isError && (
        <div className="p-6">
          <p className="text-sm text-destructive">{getApiErrorMessage(error)}</p>
        </div>
      )}

      {!isPending && !isError && runs.length === 0 && (
        <div className="p-8 text-center text-sm text-muted-foreground">
          No pipeline runs yet. Click "Trigger run" to execute your first pipeline.
        </div>
      )}

      {!isPending && !isError && runs.length > 0 && (
        <div className="divide-y">
          {runs.map((run) => (
            <Link
              key={run.id}
              to={`/projects/${projectId}/runs/${run.id}`}
              className="flex items-center justify-between gap-4 p-4 transition-colors hover:bg-muted/40"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2.5">
                  <span
                    className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium capitalize ${getStatusBadgeClasses(
                      run.status,
                    )}`}
                  >
                    {run.status}
                  </span>

                  <span className="font-mono text-xs text-muted-foreground">
                    #{run.id.slice(0, 8)}
                  </span>

                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    {run.trigger}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <GitBranch className="size-3.5" />
                    {run.branch}
                  </span>

                  <span className="inline-flex items-center gap-1 font-mono">
                    <GitCommitHorizontal className="size-3.5" />
                    {run.commitSha.slice(0, 10)}
                  </span>

                  <span>
                    {new Date(run.createdAt).toLocaleString()}
                  </span>
                </div>
              </div>

              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          ))}
        </div>
      )}
    </section>
  );
};