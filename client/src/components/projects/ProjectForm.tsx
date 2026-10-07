import {
  useEffect,
  useState,
  type FormEvent,
} from "react";

import { Loader2 } from "lucide-react";

import type {
  CreateProjectInput,
  Project,
  UpdateProjectInput,
} from "@/types/project";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface BaseProjectFormProps {
  onCancel?: () => void;
  isPending: boolean;
}

interface CreateProjectFormProps extends BaseProjectFormProps {
  project?: undefined;
  onSubmit: (data: CreateProjectInput) => Promise<void>;
}

interface EditProjectFormProps extends BaseProjectFormProps {
  project: Project;
  onSubmit: (data: UpdateProjectInput) => Promise<void>;
}

type ProjectFormProps =
  | CreateProjectFormProps
  | EditProjectFormProps;

export const ProjectForm = (props: ProjectFormProps) => {
  const { onCancel, isPending } = props;

  const [name, setName] = useState(
    props.project?.name ?? "",
  );

  const [repositoryUrl, setRepositoryUrl] = useState(
    props.project?.repositoryUrl ?? "",
  );

  const [repositoryFullName, setRepositoryFullName] =
    useState(props.project?.repositoryFullName ?? "");

  const [defaultBranch, setDefaultBranch] = useState(
    props.project?.defaultBranch ?? "main",
  );

  const [pipelinePath, setPipelinePath] = useState(
    props.project?.pipelinePath ?? ".cicd/pipeline.yaml",
  );

  useEffect(() => {
    if (!props.project) {
      setName("");
      setRepositoryUrl("");
      setRepositoryFullName("");
      setDefaultBranch("main");
      setPipelinePath(".cicd/pipeline.yaml");
      return;
    }

    setName(props.project.name);
    setRepositoryUrl(props.project.repositoryUrl);
    setRepositoryFullName(props.project.repositoryFullName);
    setDefaultBranch(props.project.defaultBranch);
    setPipelinePath(props.project.pipelinePath);
  }, [props.project]);

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();

    if (props.project !== undefined) {
      await props.onSubmit({
        name: name.trim(),
        defaultBranch: defaultBranch.trim(),
        pipelinePath: pipelinePath.trim(),
      });

      return;
    }

    await props.onSubmit({
      name: name.trim(),
      repositoryUrl: repositoryUrl.trim(),
      repositoryFullName: repositoryFullName.trim(),
      defaultBranch: defaultBranch.trim(),
      pipelinePath: pipelinePath.trim(),
    });
  };

  const isEditMode = props.project !== undefined;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="project-name">
          Project name
        </Label>

        <Input
          id="project-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="My backend"
          minLength={3}
          maxLength={128}
          required
        />
      </div>

      {!isEditMode && (
        <>
          <div className="space-y-2">
            <Label htmlFor="repository-url">
              Repository URL
            </Label>

            <Input
              id="repository-url"
              type="url"
              value={repositoryUrl}
              onChange={(event) =>
                setRepositoryUrl(event.target.value)
              }
              placeholder="https://github.com/acme/my-app"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="repository-full-name">
              Repository
            </Label>

            <Input
              id="repository-full-name"
              value={repositoryFullName}
              onChange={(event) =>
                setRepositoryFullName(event.target.value)
              }
              placeholder="acme/my-app"
              required
            />

            <p className="text-xs text-muted-foreground">
              Use owner/repository format.
            </p>
          </div>
        </>
      )}

      <div className="space-y-2">
        <Label htmlFor="default-branch">
          Default branch
        </Label>

        <Input
          id="default-branch"
          value={defaultBranch}
          onChange={(event) =>
            setDefaultBranch(event.target.value)
          }
          placeholder="main"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="pipeline-path">
          Pipeline path
        </Label>

        <Input
          id="pipeline-path"
          value={pipelinePath}
          onChange={(event) =>
            setPipelinePath(event.target.value)
          }
          placeholder=".cicd/pipeline.yaml"
          required
        />

        <p className="text-xs text-muted-foreground">
          Path to the pipeline definition inside the
          repository.
        </p>
      </div>

      <div className="flex justify-end gap-3">
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isPending}
          >
            Cancel
          </Button>
        )}

        <Button
          type="submit"
          disabled={isPending}
        >
          {isPending && (
            <Loader2 className="size-4 animate-spin" />
          )}

          {isPending
            ? "Saving..."
            : isEditMode
              ? "Save changes"
              : "Create project"}
        </Button>
      </div>
    </form>
  );
};