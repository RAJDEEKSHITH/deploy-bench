import { useState } from "react";

import {
  KeyRound,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

import {
  useDeleteProjectSecret,
  useProjectSecrets,
} from "@/hooks/useSecrets";

import type { Secret } from "@/types/secret";

import { getApiErrorMessage } from "@/lib/api-error";

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

import SecretDialog from "./SecretDialog";
import DeleteSecretDialog from "./DeleteSecretDialog";

interface ProjectSecretsProps {
  projectId: string;
}

const formatDate = (value: string): string => {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
};

const ProjectSecrets = ({
  projectId,
}: ProjectSecretsProps) => {
  const {
    data: secrets = [],
    isPending,
    isError,
    error,
  } = useProjectSecrets(projectId);

  const deleteMutation =
    useDeleteProjectSecret(projectId);

  const [createOpen, setCreateOpen] =
    useState(false);

  const [editingSecret, setEditingSecret] =
    useState<Secret | undefined>();

  const [deletingSecret, setDeletingSecret] =
    useState<Secret | undefined>();

  const handleDelete = async () => {
    if (!deletingSecret) {
      return;
    }

    try {
      await deleteMutation.mutateAsync(
        deletingSecret.id,
      );

      setDeletingSecret(undefined);
    } catch {
      // Error is handled by the mutation toast.
    }
  };

  return (
    <>
      <section className="mt-8 rounded-xl border bg-background">
        <div className="flex flex-col gap-4 border-b p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <KeyRound className="size-5 text-muted-foreground" />

              <h2 className="font-medium">
                Project secrets
              </h2>
            </div>

            <p className="mt-1 text-sm text-muted-foreground">
              Secure values available to this project's
              pipelines.
            </p>
          </div>

          <Button
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="size-4" />
            Add secret
          </Button>
        </div>

        {isPending && (
          <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading secrets...
          </div>
        )}

        {isError && (
          <div className="p-6">
            <p className="text-sm text-destructive">
              {getApiErrorMessage(error)}
            </p>
          </div>
        )}

        {!isPending &&
          !isError &&
          secrets.length === 0 && (
            <div className="p-10 text-center">
              <KeyRound className="mx-auto size-8 text-muted-foreground" />

              <h3 className="mt-4 font-medium">
                No project secrets
              </h3>

              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                Add a secret such as GITHUB_TOKEN or
                DATABASE_URL for your pipelines to use.
              </p>

              <Button
                className="mt-5"
                onClick={() => setCreateOpen(true)}
              >
                <Plus className="size-4" />
                Add secret
              </Button>
            </div>
          )}

        {!isPending &&
          !isError &&
          secrets.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      Name
                    </TableHead>

                    <TableHead className="hidden sm:table-cell">
                      Created
                    </TableHead>

                    <TableHead className="hidden md:table-cell">
                      Updated
                    </TableHead>

                    <TableHead className="w-12">
                      <span className="sr-only">
                        Actions
                      </span>
                    </TableHead>
                  </TableRow>
                </TableHeader>

                <TableBody>
                  {secrets.map((secret) => (
                    <TableRow key={secret.id}>
                      <TableCell>
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                            <KeyRound className="size-4 text-muted-foreground" />
                          </div>

                          <div className="min-w-0">
                            <p className="truncate font-mono text-sm font-medium">
                              {secret.name}
                            </p>

                            <p className="text-xs text-muted-foreground">
                              Value hidden
                            </p>
                          </div>
                        </div>
                      </TableCell>

                      <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">
                        {formatDate(secret.createdAt)}
                      </TableCell>

                      <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                        {formatDate(secret.updatedAt)}
                      </TableCell>

                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8"
                                aria-label={`Actions for ${secret.name}`}
                              />
                            }
                          >
                            <MoreHorizontal className="size-4" />
                          </DropdownMenuTrigger>

                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() =>
                                setEditingSecret(secret)
                              }
                            >
                              <Pencil className="size-4" />
                              Edit
                            </DropdownMenuItem>

                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() =>
                                setDeletingSecret(secret)
                              }
                            >
                              <Trash2 className="size-4" />
                              Delete
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
      </section>

      <SecretDialog
        projectId={projectId}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />

      <SecretDialog
        projectId={projectId}
        secret={editingSecret}
        open={editingSecret !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setEditingSecret(undefined);
          }
        }}
      />

      <DeleteSecretDialog
        open={deletingSecret !== undefined}
        secretName={deletingSecret?.name ?? ""}
        isPending={deleteMutation.isPending}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) {
            setDeletingSecret(undefined);
          }
        }}
        onConfirm={handleDelete}
      />
    </>
  );
};

export default ProjectSecrets;