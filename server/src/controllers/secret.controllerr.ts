import type {NextFunction,Request,Response} from "express";
import {
  createSecret,
  deleteSecret,
  getSecret,
  listSecrets,
  updateSecret,
} from "../services/secrets/secret.service.js";
import type { SecretScope } from "../services/secrets/secret.service.js";
import type {
  CreateSecretInput,
  UpdateSecretInput,
  ProjectSecretParams,
  ProjectSecretIdParams,
  EnvironmentSecretParams,
  EnvironmentSecretIdParams,
} from "../validators/secrets/secret.validator.js";

// project scope secrets

export const createProjectSecret = async (
  req: Request<ProjectSecretParams,any,CreateSecretInput>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const scope: SecretScope = {
      kind: "project",
      projectId: req.params.projectId,
    };

    const secret = await createSecret(req.user!.id, scope,
      {
        name: req.body.name,
        value: req.body.value,
      });

     return res.status(201).json({
      success: true,
      message: "secret created",
      data: {
        secret,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const listProjectSecrets = async (
  req: Request<ProjectSecretParams>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const scope: SecretScope = {
      kind: "project",
      projectId: req.params.projectId,
    };

    const secrets = await listSecrets(req.user!.id, scope);

    return res.status(200).json({
      success: true,
      message: "secrets fetched",
      data: {
        secrets,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getProjectSecret = async (
  req: Request<ProjectSecretIdParams>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const scope: SecretScope = {
      kind: "project",
      projectId: req.params.projectId,
    };

    const secret = await getSecret(req.user!.id, scope, req.params.secretId);

    return res.status(200).json({
      success: true,
      message: "secret fetched",
      data: {
        secret,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const updateProjectSecret = async (
  req: Request<ProjectSecretIdParams, any, UpdateSecretInput>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const scope: SecretScope = {
      kind: "project",
      projectId: req.params.projectId,
    };

    const secret = await updateSecret(req.user!.id, scope, req.params.secretId,
      {
        name: req.body.name,
        value: req.body.value,
      });

    return res.status(200).json({
      success: true,
      message: "secret updated",
      data: {
        secret,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const deleteProjectSecret = async (
  req: Request<ProjectSecretIdParams>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const scope: SecretScope = {
      kind: "project",
      projectId: req.params.projectId,
    };

    const result = await deleteSecret(req.user!.id,scope,req.params.secretId);

    return res.status(200).json({
      success: true,
      message: "secret deleted",
      data: {
        secret: result,
      },
    });
  } catch (error) {
    next(error);
  }
};


 // Environment-scoped secrets

export const createEnvironmentSecret = async (
  req: Request<EnvironmentSecretParams, any, CreateSecretInput>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const scope: SecretScope = {
      kind: "environment",
      projectId: req.params.projectId,
      environmentId: req.params.environmentId,
    };

    const secret = await createSecret(req.user!.id,scope,
      {
        name: req.body.name,
        value: req.body.value,
      });

    return res.status(201).json({
      success: true,
      message: "secret created",
      data: {
        secret,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const listEnvironmentSecrets =
  async (
    req: Request<EnvironmentSecretParams>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const scope: SecretScope = {
        kind: "environment",
        projectId: req.params.projectId,
        environmentId: req.params.environmentId,
      };

      const secrets = await listSecrets(req.user!.id,scope);

      return res.status(200).json({
        success: true,
        message: "secrets fetched",
        data: {
          secrets,
        },
      });
    } catch (error) {
      next(error);
    }
  };

export const getEnvironmentSecret =
  async (
    req: Request<EnvironmentSecretIdParams>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const scope: SecretScope = {
        kind: "environment",
        projectId: req.params.projectId,
        environmentId: req.params.environmentId,
      };

      const secret = await getSecret(req.user!.id, scope, req.params.secretId);

      return res.status(200).json({
        success: true,
        message: "secret fetched",
        data: {
          secret,
        },
      });
    } catch (error) {
      next(error);
    }
  };

export const updateEnvironmentSecret =
  async (
    req: Request<EnvironmentSecretIdParams, any, UpdateSecretInput>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const scope: SecretScope = {
        kind: "environment",
        projectId: req.params.projectId,
        environmentId: req.params.environmentId,
      };

      const secret = await updateSecret(req.user!.id, scope, req.params.secretId,
          {
            name: req.body.name,
            value: req.body.value,
          });

      return res.status(200).json({
        success: true,
        message: "secret updated",
        data: {
          secret,
        },
      });
    } catch (error) {
      next(error);
    }
  };

export const deleteEnvironmentSecret =
  async (
    req: Request<EnvironmentSecretIdParams>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const scope: SecretScope = {
        kind: "environment",
        projectId: req.params.projectId,
        environmentId: req.params.environmentId,
      };

      const result = await deleteSecret(req.user!.id, scope, req.params.secretId);

      return res.status(200).json({
        success: true,
        message: "secret deleted",
        data: {
          secret: result,
        },
      });
    } catch (error) {
      next(error);
    }
  };