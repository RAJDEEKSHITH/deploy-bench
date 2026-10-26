import { useEffect, useState, type FormEvent } from "react";
import { Loader2, ShieldCheck } from "lucide-react";

import {
  useCreateEnvironment,
  useUpdateEnvironment,
} from "@/hooks/useDeployments";
import type {
  CreateEnvironmentInput,
  DeploymentTargetType,
  Environment,
  UpdateEnvironmentInput,
} from "@/types/deployment";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface EnvironmentSettingsDialogProps {
  projectId: string;
  defaultBranch: string;
  environment?: Environment | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const recordValue = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const stringConfigValue = (
  config: Record<string, unknown>,
  key: string,
  fallback = "",
): string => {
  const value = config[key];
  return typeof value === "string" ? value : fallback;
};

const numberConfigValue = (
  config: Record<string, unknown>,
  key: string,
  fallback: number,
): string => {
  const value = config[key];
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return value.trim();
  return String(fallback);
};

const EnvironmentSettingsDialog = ({
  projectId,
  defaultBranch,
  environment,
  open,
  onOpenChange,
}: EnvironmentSettingsDialogProps) => {
  const isEditMode = environment !== undefined;
  const createMutation = useCreateEnvironment(projectId);
  const updateMutation = useUpdateEnvironment(projectId, environment?.id ?? "");
  const isPending = isEditMode ? updateMutation.isPending : createMutation.isPending;

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [targetType, setTargetType] = useState<DeploymentTargetType>("s3");
  const [deploymentBranch, setDeploymentBranch] = useState(defaultBranch);
  const [healthCheckUrl, setHealthCheckUrl] = useState("");

  const [s3BucketName, setS3BucketName] = useState("");
  const [s3Region, setS3Region] = useState("ap-south-1");
  const [s3Prefix, setS3Prefix] = useState(".");

  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshUsername, setSshUsername] = useState("ubuntu");
  const [sshPrivateKeySecretName, setSshPrivateKeySecretName] = useState("DEPLOYBENCH_SSH_PRIVATE_KEY");
  const [sshKnownHostsSecretName, setSshKnownHostsSecretName] = useState("DEPLOYBENCH_SSH_KNOWN_HOSTS");
  const [sshContainerName, setSshContainerName] = useState("deploybench-app");
  const [sshHostPort, setSshHostPort] = useState("80");
  const [sshContainerPort, setSshContainerPort] = useState("3000");
  const [sshEnvFileSecretName, setSshEnvFileSecretName] = useState("");

  useEffect(() => {
    if (!open) return;
    const config = recordValue(environment?.targetConfig);

    setName(environment?.name ?? "");
    setSlug(environment?.slug ?? "");
    setTargetType(environment?.targetType ?? "s3");
    setDeploymentBranch(environment?.deploymentBranch ?? defaultBranch);
    setHealthCheckUrl(environment?.healthCheckUrl ?? "");

    setS3BucketName(stringConfigValue(config, "bucketName"));
    setS3Region(stringConfigValue(config, "region", "ap-south-1"));
    setS3Prefix(stringConfigValue(config, "prefix", "."));

    setSshHost(stringConfigValue(config, "host"));
    setSshPort(numberConfigValue(config, "sshPort", 22));
    setSshUsername(stringConfigValue(config, "username", "ubuntu"));
    setSshPrivateKeySecretName(stringConfigValue(config, "privateKeySecretName", "DEPLOYBENCH_SSH_PRIVATE_KEY"));
    setSshKnownHostsSecretName(stringConfigValue(config, "knownHostsSecretName", "DEPLOYBENCH_SSH_KNOWN_HOSTS"));
    setSshContainerName(stringConfigValue(config, "containerName", "deploybench-app"));
    setSshHostPort(numberConfigValue(config, "hostPort", 80));
    setSshContainerPort(numberConfigValue(config, "containerPort", 3000));
    setSshEnvFileSecretName(stringConfigValue(config, "envFileSecretName"));
  }, [open, environment, defaultBranch]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const targetConfig: Record<string, unknown> = targetType === "s3"
      ? {
          bucketName: s3BucketName.trim().toLowerCase(),
          region: s3Region.trim(),
          prefix: s3Prefix.trim(),
        }
      : {
          host: sshHost.trim(),
          sshPort: Number(sshPort),
          username: sshUsername.trim(),
          privateKeySecretName: sshPrivateKeySecretName.trim(),
          knownHostsSecretName: sshKnownHostsSecretName.trim(),
          containerName: sshContainerName.trim(),
          hostPort: Number(sshHostPort),
          containerPort: Number(sshContainerPort),
          ...(sshEnvFileSecretName.trim()
            ? { envFileSecretName: sshEnvFileSecretName.trim() }
            : {}),
        };

    try {
      if (environment !== undefined) {
        // Changing target type after deployments exist can violate the target's
        // release-reference invariant; keep the target type immutable here.
        const input: UpdateEnvironmentInput = {
          name: name.trim(),
          slug: slug.trim().toLowerCase(),
          targetType: environment.targetType,
          targetConfig,
          deploymentBranch: deploymentBranch.trim(),
          healthCheckUrl: targetType === "ssh_ec2" ? healthCheckUrl.trim() : null,
        };
        await updateMutation.mutateAsync(input);
      } else {
        const input: CreateEnvironmentInput = {
          name: name.trim(),
          slug: slug.trim().toLowerCase(),
          targetType,
          targetConfig,
          deploymentBranch: deploymentBranch.trim(),
          ...(targetType === "ssh_ec2" ? { healthCheckUrl: healthCheckUrl.trim() } : {}),
        };
        await createMutation.mutateAsync(input);
      }
      onOpenChange(false);
    } catch {
      // The mutation hooks display a toast. Keep the dialog open for correction.
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isPending) onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditMode ? `Edit ${environment.name}` : "Create environment"}</DialogTitle>
          <DialogDescription>
            Configure the deployment destination. Credentials are stored as encrypted secrets, not in target configuration.
            {isEditMode ? " The target type cannot be changed after creation." : ""}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`env-name-${environment?.id ?? "new"}`}>Environment name</Label>
              <Input
                id={`env-name-${environment?.id ?? "new"}`}
                value={name}
                onChange={(event) => {
                  const value = event.target.value;
                  setName(value);
                  if (!isEditMode && !slug) {
                    setSlug(value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
                  }
                }}
                maxLength={128}
                required
                disabled={isPending}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`env-slug-${environment?.id ?? "new"}`}>Slug</Label>
              <Input
                id={`env-slug-${environment?.id ?? "new"}`}
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                maxLength={128}
                required
                disabled={isPending}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`env-target-${environment?.id ?? "new"}`}>Target type</Label>
              <select
                id={`env-target-${environment?.id ?? "new"}`}
                value={targetType}
                onChange={(event) => setTargetType(event.target.value as DeploymentTargetType)}
                disabled={isEditMode || isPending}
                className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm disabled:opacity-60"
              >
                <option value="s3">S3 static frontend</option>
                <option value="ssh_ec2">SSH EC2 container</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`env-branch-${environment?.id ?? "new"}`}>Deployment branch</Label>
              <Input
                id={`env-branch-${environment?.id ?? "new"}`}
                value={deploymentBranch}
                onChange={(event) => setDeploymentBranch(event.target.value)}
                maxLength={128}
                required
                disabled={isPending}
              />
            </div>
          </div>

          {targetType === "s3" && (
            <div className="space-y-3 rounded-lg border p-4">
              <h3 className="text-sm font-medium">S3 static site destination</h3>
              <div className="space-y-1.5">
                <Label htmlFor={`env-s3-bucket-${environment?.id ?? "new"}`}>Target bucket name</Label>
                <Input
                  id={`env-s3-bucket-${environment?.id ?? "new"}`}
                  value={s3BucketName}
                  onChange={(event) => setS3BucketName(event.target.value)}
                  placeholder="my-production-site"
                  autoComplete="off"
                  required
                  disabled={isPending}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`env-s3-region-${environment?.id ?? "new"}`}>AWS region</Label>
                  <Input
                    id={`env-s3-region-${environment?.id ?? "new"}`}
                    value={s3Region}
                    onChange={(event) => setS3Region(event.target.value)}
                    placeholder="ap-south-1"
                    required
                    disabled={isPending}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`env-s3-prefix-${environment?.id ?? "new"}`}>Object prefix</Label>
                  <Input
                    id={`env-s3-prefix-${environment?.id ?? "new"}`}
                    value={s3Prefix}
                    onChange={(event) => setS3Prefix(event.target.value)}
                    placeholder="production"
                    required
                    disabled={isPending}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Use a dedicated bucket or a dedicated prefix such as <code>production</code>. Use <code>.</code> only when the whole bucket is dedicated to this site; stale files at that root are removed during sync.
              </p>
              <p className="text-xs text-muted-foreground">
                To use another AWS account, add the S3_DEPLOY_AWS_ACCESS_KEY_ID and S3_DEPLOY_AWS_SECRET_ACCESS_KEY secrets below. Otherwise DeployBench uses the server's AWS identity.
              </p>
            </div>
          )}

          {targetType === "ssh_ec2" && (
            <div className="space-y-3 rounded-lg border p-4">
              <h3 className="text-sm font-medium">EC2 SSH destination</h3>
              <div className="space-y-1.5">
                <Label htmlFor={`env-ssh-host-${environment?.id ?? "new"}`}>Public IP or DNS hostname</Label>
                <Input
                  id={`env-ssh-host-${environment?.id ?? "new"}`}
                  value={sshHost}
                  onChange={(event) => setSshHost(event.target.value)}
                  placeholder="ec2-xx-xx-xx-xx.ap-south-1.compute.amazonaws.com"
                  required
                  disabled={isPending}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`env-ssh-port-${environment?.id ?? "new"}`}>SSH port</Label>
                  <Input id={`env-ssh-port-${environment?.id ?? "new"}`} type="number" min="1" max="65535" value={sshPort} onChange={(event) => setSshPort(event.target.value)} required disabled={isPending} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`env-ssh-user-${environment?.id ?? "new"}`}>SSH username</Label>
                  <Input id={`env-ssh-user-${environment?.id ?? "new"}`} value={sshUsername} onChange={(event) => setSshUsername(event.target.value)} required disabled={isPending} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`env-ssh-host-port-${environment?.id ?? "new"}`}>EC2 host port</Label>
                  <Input id={`env-ssh-host-port-${environment?.id ?? "new"}`} type="number" min="1" max="65535" value={sshHostPort} onChange={(event) => setSshHostPort(event.target.value)} required disabled={isPending} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`env-ssh-container-port-${environment?.id ?? "new"}`}>Container port</Label>
                  <Input id={`env-ssh-container-port-${environment?.id ?? "new"}`} type="number" min="1" max="65535" value={sshContainerPort} onChange={(event) => setSshContainerPort(event.target.value)} required disabled={isPending} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`env-ssh-private-key-secret-${environment?.id ?? "new"}`}>Private-key environment secret name</Label>
                <Input id={`env-ssh-private-key-secret-${environment?.id ?? "new"}`} value={sshPrivateKeySecretName} onChange={(event) => setSshPrivateKeySecretName(event.target.value.toUpperCase())} pattern="[A-Z][A-Z0-9_]*" required disabled={isPending} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`env-ssh-known-hosts-${environment?.id ?? "new"}`}>Known-hosts environment secret name</Label>
                <Input id={`env-ssh-known-hosts-${environment?.id ?? "new"}`} value={sshKnownHostsSecretName} onChange={(event) => setSshKnownHostsSecretName(event.target.value.toUpperCase())} pattern="[A-Z][A-Z0-9_]*" required disabled={isPending} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`env-ssh-container-name-${environment?.id ?? "new"}`}>Container name</Label>
                <Input id={`env-ssh-container-name-${environment?.id ?? "new"}`} value={sshContainerName} onChange={(event) => setSshContainerName(event.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,47}" required disabled={isPending} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`env-ssh-env-file-${environment?.id ?? "new"}`}>Optional environment-file secret name</Label>
                <Input id={`env-ssh-env-file-${environment?.id ?? "new"}`} value={sshEnvFileSecretName} onChange={(event) => setSshEnvFileSecretName(event.target.value.toUpperCase())} pattern="[A-Z][A-Z0-9_]*" placeholder="PRODUCTION_ENV_FILE" disabled={isPending} />
              </div>
              <p className="text-xs text-muted-foreground">
                The EC2 host must have Docker installed and be reachable from the DeployBench worker. Create the private key and verified known_hosts entries as environment-scoped secrets after saving these settings.
              </p>
              <div className="flex items-start gap-2 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-4 shrink-0" />
                ECR access is configured using project-scoped secrets named ECR_AWS_ACCESS_KEY_ID and ECR_AWS_SECRET_ACCESS_KEY. Do not paste the private key or AWS credentials into these settings fields.
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`env-health-url-${environment?.id ?? "new"}`}>Health-check URL (required)</Label>
                <Input id={`env-health-url-${environment?.id ?? "new"}`} type="url" value={healthCheckUrl} onChange={(event) => setHealthCheckUrl(event.target.value)} placeholder="https://api.example.com/health" required disabled={isPending} />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>Cancel</Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="size-4 animate-spin" />}
              {isPending ? "Saving..." : isEditMode ? "Save settings" : "Create environment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default EnvironmentSettingsDialog;
