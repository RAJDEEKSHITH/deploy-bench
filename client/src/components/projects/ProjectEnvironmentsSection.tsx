import { useState, type FormEvent } from "react";
import {
  Globe,
  History,
  Loader2,
  Plus,
  Rocket,
  Settings2,
  RotateCcw,
  Trash2,
} from "lucide-react";

import {
  useDeleteEnvironment,
  useEnvironmentDeployments,
  useProjectEnvironments,
  useRollbackDeployment,
  useTriggerDeployment,
} from "@/hooks/useDeployments";
import { useProjectRuns } from "@/hooks/useRuns";
import { getApiErrorMessage } from "@/lib/api-error";
import EnvironmentSecretsPanel from "@/components/projects/EnvironmentSecretsPanel";
import EnvironmentSettingsDialog from "@/components/projects/EnvironmentSettingsDialog";
import type { Environment } from "@/types/deployment";

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

interface ProjectEnvironmentsSectionProps {
  projectId: string;
  defaultBranch: string;
}

const EnvironmentCardItem = ({
  projectId,
  environment,
}: {
  projectId: string;
  environment: Environment;
}) => {
  const { data: deployments = [], isPending: isLoadingHistory } =
    useEnvironmentDeployments(environment.id);
  const { data: runs = [] } = useProjectRuns(projectId);

  const deployMutation = useTriggerDeployment(projectId, environment.id);
  const rollbackMutation = useRollbackDeployment(projectId, environment.id);
  const deleteEnvMutation = useDeleteEnvironment(projectId);

  const [deployOpen, setDeployOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [releaseId, setReleaseId] = useState("");

  const successfulRuns = runs.filter(
    (r) =>
      r.status === "success" && r.branch === environment.deploymentBranch,
  );

  const handleDeploy = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedRunId.trim() || !releaseId.trim()) return;

    try {
      await deployMutation.mutateAsync({
        runId: selectedRunId.trim(),
        ...(environment.targetType === "s3"
          ? { artifactId: releaseId.trim() }
          : { containerImageId: releaseId.trim() }),
      });
      setDeployOpen(false);
    } catch {
      // Handled by toast
    }
  };

  return (
    <div className="rounded-lg border p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-medium">{environment.name}</h3>
            <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
              {environment.slug}
            </span>
            <span className="rounded border px-2 py-0.5 text-xs font-medium uppercase">
              {environment.targetType}
            </span>
          </div>

          <p className="mt-1 text-xs text-muted-foreground">
            Branch: <strong>{environment.deploymentBranch}</strong>
            {environment.currentCommitSha && (
              <>
                {" "}
                · Active commit:{" "}
                <span className="font-mono">
                  {environment.currentCommitSha.slice(0, 8)}
                </span>
              </>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Dialog open={deployOpen} onOpenChange={setDeployOpen}>
            <DialogTrigger
              render={<Button size="sm" variant="outline" />}
            >
              <Rocket className="size-3.5" />
              Deploy
            </DialogTrigger>

            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Deploy to {environment.name}</DialogTitle>
                <DialogDescription>
                  Select the latest successful run on{" "}
                  <strong>{environment.deploymentBranch}</strong> and provide the{" "}
                  {environment.targetType === "s3"
                    ? "Artifact ID"
                    : "Container Image ID"}
                  .
                </DialogDescription>
              </DialogHeader>

              <form onSubmit={handleDeploy} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor={`run-select-${environment.id}`}>
                    Successful Run ID
                  </Label>
                  <Input
                    id={`run-select-${environment.id}`}
                    value={selectedRunId}
                    onChange={(e) => setSelectedRunId(e.target.value)}
                    placeholder={
                      successfulRuns[0]?.id ??
                      "Paste successful Run UUID"
                    }
                    required
                  />
                  {successfulRuns.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Latest eligible run:{" "}
                      <button
                        type="button"
                        className="font-mono underline"
                        onClick={() =>
                          setSelectedRunId(successfulRuns[0]!.id)
                        }
                      >
                        {successfulRuns[0]!.id.slice(0, 8)} (
                        {successfulRuns[0]!.commitSha.slice(0, 7)})
                      </button>
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor={`release-id-${environment.id}`}>
                    {environment.targetType === "s3"
                      ? "Artifact UUID"
                      : "Container Image UUID"}
                  </Label>
                  <Input
                    id={`release-id-${environment.id}`}
                    value={releaseId}
                    onChange={(e) => setReleaseId(e.target.value)}
                    placeholder="UUID from run details"
                    required
                  />
                </div>

                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setDeployOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={deployMutation.isPending}
                  >
                    {deployMutation.isPending && (
                      <Loader2 className="size-4 animate-spin" />
                    )}
                    Queue deployment
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>

          <Button
            size="sm"
            variant="outline"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 className="size-3.5" />
            Settings
          </Button>

          <Button
            size="sm"
            variant="outline"
            disabled={rollbackMutation.isPending}
            onClick={() => rollbackMutation.mutate(undefined)}
          >
            <RotateCcw className="size-3.5" />
            Rollback
          </Button>

          <Button
            size="icon-sm"
            variant="ghost"
            disabled={deleteEnvMutation.isPending}
            onClick={() => deleteEnvMutation.mutate(environment.id)}
            aria-label="Delete environment"
          >
            <Trash2 className="size-4 text-destructive" />
          </Button>
        </div>
      </div>

      {/* Recent Deployments */}
      <div className="border-t pt-3">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <History className="size-3.5" />
          Recent deployments
        </p>

        {isLoadingHistory ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Loading deployment history...
          </p>
        ) : deployments.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            No deployments recorded for this environment.
          </p>
        ) : (
          <div className="mt-2 space-y-1.5">
            {deployments.slice(0, 5).map((dep) => (
              <div
                key={dep.id}
                className="flex items-center justify-between rounded bg-muted/40 px-3 py-1.5 text-xs"
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium uppercase">{dep.action}</span>
                  <span className="rounded border px-1.5 py-0.5 capitalize">
                    {dep.status}
                  </span>
                  <span className="font-mono text-muted-foreground">
                    {dep.commitSha.slice(0, 8)}
                  </span>
                </div>
                <span className="text-muted-foreground">
                  {new Date(dep.createdAt).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <EnvironmentSecretsPanel
        projectId={projectId}
        environmentId={environment.id}
        targetType={environment.targetType}
      />
      <EnvironmentSettingsDialog
        projectId={projectId}
        defaultBranch={environment.deploymentBranch}
        environment={environment}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </div>
  );
};

export const ProjectEnvironmentsSection = ({
  projectId,
  defaultBranch,
}: ProjectEnvironmentsSectionProps) => {
  const {
    data: environments = [],
    isPending,
    isError,
    error,
  } = useProjectEnvironments(projectId);

  const [createOpen, setCreateOpen] = useState(false);

  return (
    <section className="mt-8 rounded-xl border bg-background">
      <div className="flex flex-col gap-4 border-b p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Globe className="size-5 text-muted-foreground" />
            <h2 className="font-medium">Environments & Deployments</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage deployment targets (S3 or SSH EC2), trigger releases, and roll back.
          </p>
        </div>

        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          Add environment
        </Button>
      </div>

      <EnvironmentSettingsDialog
        projectId={projectId}
        defaultBranch={defaultBranch}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />

      <div className="p-6">
        {isPending && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading environments...
          </div>
        )}

        {isError && (
          <p className="text-sm text-destructive">{getApiErrorMessage(error)}</p>
        )}

        {!isPending && !isError && environments.length === 0 && (
          <p className="text-center text-sm text-muted-foreground py-4">
            No environments configured yet.
          </p>
        )}

        {!isPending && !isError && environments.length > 0 && (
          <div className="space-y-4">
            {environments.map((envItem) => (
              <EnvironmentCardItem
                key={envItem.id}
                projectId={projectId}
                environment={envItem}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
};