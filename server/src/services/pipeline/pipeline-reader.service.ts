import {
  readFileAtCommit,
  withRepositoryAtCommit,
} from "../github/github-repository.service.js";

export type ReadPipelineAtCommitInput = {
  repositoryUrl: string;
  commitSha: string;
  pipelinePath: string;
  accessToken?: string | undefined;
};

/**
 * Returns the raw pipeline YAML at the exact commit,
 * or null when the file does not exist at that commit.
 */
export const readPipelineAtCommit = ({
  repositoryUrl,
  commitSha,
  pipelinePath,
  accessToken,
}: ReadPipelineAtCommitInput): Promise<string | null> =>
  withRepositoryAtCommit(
    { repositoryUrl, commitSha, accessToken, checkout: false },
    (workspace) =>
      readFileAtCommit({
        workspacePath: workspace.path,
        commitSha: workspace.commitSha,
        filePath: pipelinePath,
      }),
  );