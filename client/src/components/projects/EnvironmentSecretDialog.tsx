import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, Loader2 } from "lucide-react";

import {
  useCreateEnvironmentSecret,
  useUpdateEnvironmentSecret,
} from "@/hooks/useSecrets";
import type { CreateSecretInput, Secret } from "@/types/secret";
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
import { Textarea } from "@/components/ui/textarea";

interface EnvironmentSecretDialogProps {
  projectId: string;
  environmentId: string;
  secret?: Secret | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SECRET_NAME_PATTERN = "^[A-Z][A-Z0-9_]*$";

const EnvironmentSecretDialog = ({
  projectId,
  environmentId,
  secret,
  open,
  onOpenChange,
}: EnvironmentSecretDialogProps) => {
  const isEditMode = secret !== undefined;
  const createMutation = useCreateEnvironmentSecret(projectId, environmentId);
  const updateMutation = useUpdateEnvironmentSecret(
    projectId,
    environmentId,
    secret?.id ?? "",
  );
  const isPending = isEditMode ? updateMutation.isPending : createMutation.isPending;

  const [name, setName] = useState("");
  const [value, setValue] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(secret?.name ?? "");
    setValue("");
  }, [open, secret]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();

    try {
      if (isEditMode) {
        await updateMutation.mutateAsync({
          name: trimmedName,
          ...(value.length > 0 ? { value } : {}),
        });
      } else {
        const data: CreateSecretInput = { name: trimmedName, value };
        await createMutation.mutateAsync(data);
      }
      onOpenChange(false);
    } catch {
      // Mutation hooks display the error toast; keep the dialog open for correction.
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isPending) onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-muted">
            <KeyRound className="size-5 text-muted-foreground" />
          </div>
          <DialogTitle>{isEditMode ? "Edit environment secret" : "Create environment secret"}</DialogTitle>
          <DialogDescription>
            These secrets are scoped to this environment. Their values are encrypted and never shown again after saving.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor={`environment-secret-name-${environmentId}`}>Secret name</Label>
            <Input
              id={`environment-secret-name-${environmentId}`}
              value={name}
              onChange={(event) => setName(event.target.value.toUpperCase())}
              placeholder="DEPLOYBENCH_SSH_PRIVATE_KEY"
              maxLength={128}
              pattern={SECRET_NAME_PATTERN}
              title="Use uppercase letters, numbers, and underscores. The name must start with a letter."
              required
              autoComplete="off"
              disabled={isPending}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={`environment-secret-value-${environmentId}`}>
              {isEditMode ? "New secret value (optional)" : "Secret value"}
            </Label>
            <Textarea
              id={`environment-secret-value-${environmentId}`}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={isEditMode ? "Leave blank to keep the existing value" : "Paste the secret value"}
              maxLength={65536}
              required={!isEditMode}
              disabled={isPending}
              autoComplete="new-password"
              className="min-h-32 resize-y font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Maximum size: 64 KiB. For SSH, store the private key and the pinned known_hosts contents as separate secrets. Do not store these values in targetConfig or source control.
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="size-4 animate-spin" />}
              {isPending ? "Saving..." : isEditMode ? "Save changes" : "Create secret"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default EnvironmentSecretDialog;
