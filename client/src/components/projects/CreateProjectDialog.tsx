import { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

import { Button } from "@/components/ui/button";

import { ProjectForm } from "./ProjectForm";

import { useCreateProject } from "@/hooks/useProjects";
import { getApiErrorMessage } from "@/lib/api-error";

import type { CreateProjectInput } from "@/types/project";

interface CreateProjectDialogProps {
  onCreated?: (projectId: string) => void;
}

export const CreateProjectDialog = ({
  onCreated,
}: CreateProjectDialogProps) => {
  const [open, setOpen] = useState(false);

  const mutation = useCreateProject();

  const handleSubmit = async (
    data: CreateProjectInput,
  ) => {
    try {
      const response =
        await mutation.mutateAsync(data);

      setOpen(false);

      onCreated?.(response.data.project.id);
    } catch {
      // Error rendered inside dialog.
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!mutation.isPending) {
          setOpen(value);
        }
      }}
    >
      <DialogTrigger render={<Button />}>
        Create project
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Create project
          </DialogTitle>

          <DialogDescription>
            Connect a GitHub repository to DeployBench.
          </DialogDescription>
        </DialogHeader>

        {mutation.error && (
          <p className="text-sm text-destructive">
            {getApiErrorMessage(mutation.error)}
          </p>
        )}

        <ProjectForm
          onSubmit={handleSubmit}
          isPending={mutation.isPending}
          onCancel={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
};