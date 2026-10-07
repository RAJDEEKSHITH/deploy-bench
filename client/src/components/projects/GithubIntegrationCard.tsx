import {
  useEffect,
  useState,
  type FormEvent,
} from "react";

import {
  GitBranch,
  Loader2,
} from "lucide-react";

import {
  useGithubIntegration,
  useCreateGithubIntegration,
  useUpdateGithubIntegration,
} from "@/hooks/useGithubIntegration";

import { getApiErrorMessage } from "@/lib/api-error";

import type {
  CreateGithubIntegrationInput,
} from "@/types/githubIntegration";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

interface GithubIntegrationCardProps {
  projectId: string;
}

export const GithubIntegrationCard = ({
  projectId,
}: GithubIntegrationCardProps) => {
  const {
    data: integration,
    isPending: isLoading,
    isError,
    error,
  } = useGithubIntegration(projectId);

  const createMutation =
    useCreateGithubIntegration(projectId);

  const updateMutation =
    useUpdateGithubIntegration(projectId);

  const [webhookSecret, setWebhookSecret] =
    useState("");

  const [accessTokenSecretName, setAccessTokenSecretName] =
    useState("");

  const [enabled, setEnabled] = useState(true);

  const isEditMode = integration !== null;
  const isPending =
    createMutation.isPending ||
    updateMutation.isPending;

  useEffect(() => {
    if (!integration) {
      setWebhookSecret("");
      setAccessTokenSecretName("");
      setEnabled(true);
      return;
    }

    setWebhookSecret("");
    setAccessTokenSecretName(
      integration.accessTokenSecretName ?? "",
    );
    setEnabled(integration.enabled);
  }, [integration]);

  if (isLoading) {
    return (
      <section className="mt-8 rounded-xl border bg-background p-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading GitHub integration...
        </div>
      </section>
    );
  }

  if (isError) {
    return (
      <section className="mt-8 rounded-xl border bg-background p-6">
        <h2 className="font-medium">
          GitHub integration
        </h2>

        <p className="mt-2 text-sm text-destructive">
          {getApiErrorMessage(error)}
        </p>
      </section>
    );
  }

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();

    if (integration) {
      const data = {
        enabled,
        ...(webhookSecret.trim()
          ? {
              webhookSecret:
                webhookSecret.trim(),
            }
          : {}),
        ...(accessTokenSecretName.trim()
          ? {
              accessTokenSecretName:
                accessTokenSecretName.trim(),
            }
          : {}),
      };

      await updateMutation.mutateAsync(data);

      setWebhookSecret("");

      return;
    }

    const data: CreateGithubIntegrationInput = {
      webhookSecret: webhookSecret.trim(),
      enabled,
      ...(accessTokenSecretName.trim()
        ? {
            accessTokenSecretName:
              accessTokenSecretName.trim(),
          }
        : {}),
    };

    await createMutation.mutateAsync(data);

    setWebhookSecret("");
  };

  return (
    <section className="mt-8 rounded-xl border bg-background p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-medium">
            GitHub integration
          </h2>

          <p className="mt-1 text-sm text-muted-foreground">
            Configure the GitHub webhook used by
            DeployBench.
          </p>
        </div>

        {integration && (
          <div className="flex items-center gap-2 text-sm">
            <span
              className={`size-2 rounded-full ${
                integration.enabled
                  ? "bg-emerald-500"
                  : "bg-muted-foreground"
              }`}
            />

            <span className="text-muted-foreground">
              {integration.enabled
                ? "Enabled"
                : "Disabled"}
            </span>
          </div>
        )}
      </div>

      {integration && (
        <div className="mt-5 rounded-lg border bg-muted/30 p-4">
          <p className="text-sm font-medium">
            Repository
          </p>

          <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <GitBranch className="size-4" />
            {integration.repositoryFullName}
          </p>
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="mt-6 space-y-5"
      >
        <div className="space-y-2">
          <Label htmlFor="github-webhook-secret">
            Webhook secret
          </Label>

          <Input
            id="github-webhook-secret"
            type="password"
            value={webhookSecret}
            onChange={(event) =>
              setWebhookSecret(event.target.value)
            }
            placeholder={
              integration
                ? "Enter a new webhook secret"
                : "Enter GitHub webhook secret"
            }
            required={!isEditMode}
            maxLength={1024}
            autoComplete="new-password"
          />

          {integration ? (
            <p className="text-xs text-muted-foreground">
              Leave blank to keep the existing webhook
              secret. The existing secret cannot be
              retrieved.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              This secret must match the secret configured
              on the GitHub webhook.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="github-access-token-secret">
            Access token secret name
          </Label>

          <Input
            id="github-access-token-secret"
            value={accessTokenSecretName}
            onChange={(event) =>
              setAccessTokenSecretName(
                event.target.value,
              )
            }
            placeholder="GITHUB_TOKEN"
            maxLength={128}
          />

          <p className="text-xs text-muted-foreground">
            Name of the DeployBench secret containing the
            GitHub access token.
          </p>
        </div>

        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-1">
            <Label htmlFor="github-integration-enabled">
              Enable integration
            </Label>

            <p className="text-xs text-muted-foreground">
              Allow DeployBench to process GitHub
              integration events for this project.
            </p>
          </div>

          <Switch
            id="github-integration-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={isPending}
          />
        </div>

        <div className="flex justify-end">
          <Button
            type="submit"
            disabled={isPending}
          >
            {isPending && (
              <Loader2 className="size-4 animate-spin" />
            )}

            {isPending
              ? "Saving..."
              : integration
                ? "Save changes"
                : "Connect GitHub"}
          </Button>
        </div>
      </form>
    </section>
  );
};