export interface GithubIntegration {
  id: string;
  projectId: string;
  repositoryFullName: string;
  accessTokenSecretName: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateGithubIntegrationInput {
  webhookSecret: string;
  accessTokenSecretName?: string;
  enabled?: boolean;
}

export interface UpdateGithubIntegrationInput {
  webhookSecret?: string;
  accessTokenSecretName?: string | null;
  enabled?: boolean;
}

export interface GithubIntegrationResponse {
  success: boolean;
  message: string;
  data: {
    integration: GithubIntegration;
  };
}