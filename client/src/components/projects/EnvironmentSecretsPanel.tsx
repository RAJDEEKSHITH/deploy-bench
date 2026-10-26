import { useState } from "react";
import { KeyRound, Loader2, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";

import { useDeleteEnvironmentSecret, useEnvironmentSecrets } from "@/hooks/useSecrets";
import { getApiErrorMessage } from "@/lib/api-error";
import type { Secret } from "@/types/secret";
import type { DeploymentTargetType } from "@/types/deployment";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import DeleteSecretDialog from "./DeleteSecretDialog";
import EnvironmentSecretDialog from "./EnvironmentSecretDialog";

interface EnvironmentSecretsPanelProps {
  projectId: string;
  environmentId: string;
  targetType: DeploymentTargetType;
}

const formatDate = (value: string): string => new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
}).format(new Date(value));

const EnvironmentSecretsPanel = ({ projectId, environmentId, targetType }: EnvironmentSecretsPanelProps) => {
  const {
    data: secrets = [],
    isPending,
    isError,
    error,
  } = useEnvironmentSecrets(projectId, environmentId);
  const deleteMutation = useDeleteEnvironmentSecret(projectId, environmentId);

  const [createOpen, setCreateOpen] = useState(false);
  const [editingSecret, setEditingSecret] = useState<Secret | undefined>();
  const [deletingSecret, setDeletingSecret] = useState<Secret | undefined>();

  const handleDelete = async () => {
    if (!deletingSecret) return;
    try {
      await deleteMutation.mutateAsync(deletingSecret.id);
      setDeletingSecret(undefined);
    } catch {
      // Mutation hook displays an error toast.
    }
  };

  return (
    <section className="mt-4 rounded-lg border bg-background">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <div>
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" />
            <h4 className="text-sm font-medium">Environment secrets</h4>
          </div>
          <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
            {targetType === "s3"
              ? "For this environment's AWS account, add S3_DEPLOY_AWS_ACCESS_KEY_ID and S3_DEPLOY_AWS_SECRET_ACCESS_KEY as separate secrets; S3_DEPLOY_AWS_SESSION_TOKEN is optional. If the pair is absent, DeployBench falls back to the self-hosted server's AWS identity."
              : "Add the private key and verified known_hosts content using the secret names configured in the target settings. Optional: add the KEY=value environment file using the configured env-file secret name. ECR credentials are project-scoped, not stored here."}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
          <Plus className="size-3.5" />
          Add secret
        </Button>
      </div>

      {isPending && (
        <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading environment secrets...
        </div>
      )}

      {isError && <p className="p-4 text-sm text-destructive">{getApiErrorMessage(error)}</p>}

      {!isPending && !isError && secrets.length === 0 && (
        <p className="p-4 text-sm text-muted-foreground">
          {targetType === "s3"
            ? "No environment secrets yet. Add the S3 deployment credential pair here if this destination uses a different AWS identity."
            : "No environment secrets yet. Add the SSH private key and verified known_hosts values before deploying to EC2."}
        </p>
      )}

      {!isPending && !isError && secrets.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="w-12">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {secrets.map((secret) => (
                <TableRow key={secret.id}>
                  <TableCell className="font-mono text-xs">{secret.name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDate(secret.updatedAt)}</TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${secret.name}`} />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setEditingSecret(secret)}>
                          <Pencil className="size-4" /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => setDeletingSecret(secret)}>
                          <Trash2 className="size-4" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <EnvironmentSecretDialog
        projectId={projectId}
        environmentId={environmentId}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
      <EnvironmentSecretDialog
        projectId={projectId}
        environmentId={environmentId}
        secret={editingSecret}
        open={editingSecret !== undefined}
        onOpenChange={(open) => {
          if (!open) setEditingSecret(undefined);
        }}
      />
      <DeleteSecretDialog
        open={deletingSecret !== undefined}
        secretName={deletingSecret?.name ?? ""}
        isPending={deleteMutation.isPending}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) setDeletingSecret(undefined);
        }}
        onConfirm={handleDelete}
      />
    </section>
  );
};

export default EnvironmentSecretsPanel;
