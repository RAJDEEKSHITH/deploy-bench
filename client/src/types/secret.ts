export interface Secret {
  id: string;
  name: string;
  projectId: string | null;
  environmentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSecretInput {
  name: string;
  value: string;
}

export interface UpdateSecretInput {
  name?: string;
  value?: string;
}

export interface SecretResponse {
  success: boolean;
  message: string;
  data: {
    secret: Secret;
  };
}

export interface SecretsResponse {
  success: boolean;
  message: string;
  data: {
    secrets: Secret[];
  };
}

export interface DeleteSecretResponse {
  success: boolean;
  message: string;
  data: {
    secret: {
      secretId: string;
      name: string;
    };
  };
}