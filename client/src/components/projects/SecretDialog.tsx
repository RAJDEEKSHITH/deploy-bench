import {
  useEffect,
  useState,
  type FormEvent,
} from "react";

import {
  KeyRound,
  Loader2,
} from "lucide-react";

import {
  useCreateProjectSecret,
  useUpdateProjectSecret,
} from "@/hooks/useSecrets";

import type {
  CreateSecretInput,
  Secret,
} from "@/types/secret";

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

interface SecretDialogProps {
  projectId: string;
  secret?: Secret;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SECRET_NAME_PATTERN = "^[A-Z][A-Z0-9_]*$";

const SecretDialog = ({
  projectId,
  secret,
  open,
  onOpenChange,
}: SecretDialogProps) => {
  const isEditMode = secret !== undefined;

  const createMutation =
    useCreateProjectSecret(projectId);

  const updateMutation =
    useUpdateProjectSecret(
      projectId,
      secret?.id ?? "",
    );

  const [name, setName] = useState("");
  const [value, setValue] = useState("");

  const mutation = isEditMode
    ? updateMutation
    : createMutation;

  useEffect(() => {
    if (!open) {
      return;
    }

    setName(secret?.name ?? "");
    setValue("");
  }, [open, secret]);

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();

    const trimmedName = name.trim();

    if (isEditMode) {
      const trimmedValue = value;

      await updateMutation.mutateAsync({
        name: trimmedName,
        ...(trimmedValue.length > 0
          ? { value: trimmedValue }
          : {}),
      });

      onOpenChange(false);
      return;
    }

    const data: CreateSecretInput = {
      name: trimmedName,
      value,
    };

    await createMutation.mutateAsync(data);

    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!mutation.isPending) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-muted">
            <KeyRound className="size-5 text-muted-foreground" />
          </div>

          <DialogTitle>
            {isEditMode
              ? "Edit secret"
              : "Create secret"}
          </DialogTitle>

          <DialogDescription>
            {isEditMode
              ? "Update the secret name or replace its value."
              : "Store a secret securely for use by your pipelines."}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={handleSubmit}
          className="space-y-5"
        >
          <div className="space-y-2">
            <Label htmlFor="secret-name">
              Secret name
            </Label>

            <Input
              id="secret-name"
              value={name}
              onChange={(event) =>
                setName(
                  event.target.value.toUpperCase(),
                )
              }
              placeholder="GITHUB_TOKEN"
              maxLength={128}
              pattern={SECRET_NAME_PATTERN}
              title="Use uppercase letters, numbers, and underscores. The name must start with a letter."
              required
              autoComplete="off"
              disabled={mutation.isPending}
            />

            <p className="text-xs text-muted-foreground">
              Use uppercase letters, numbers, and
              underscores. Example: GITHUB_TOKEN.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="secret-value">
              {isEditMode
                ? "New secret value"
                : "Secret value"}
            </Label>

            <Textarea
              id="secret-value"
              value={value}
              onChange={(event) =>
                setValue(event.target.value)
              }
              placeholder={
                isEditMode
                  ? "Leave blank to keep the existing value"
                  : "Enter the secret value"
              }
              maxLength={65536}
              required={!isEditMode}
              disabled={mutation.isPending}
              autoComplete="new-password"
              className="min-h-32 resize-y font-mono text-sm"
            />

            <p className="text-xs text-muted-foreground">
              Maximum size: 64 KiB. The existing secret
              value cannot be retrieved.
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>

            <Button
              type="submit"
              disabled={mutation.isPending}
            >
              {mutation.isPending && (
                <Loader2 className="size-4 animate-spin" />
              )}

              {mutation.isPending
                ? "Saving..."
                : isEditMode
                  ? "Save changes"
                  : "Create secret"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default SecretDialog;