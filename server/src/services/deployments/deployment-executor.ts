import type {
  DeploymentExecutionInput,
  DeploymentTargetExecutor,
} from "../../workers/deployment.worker.js";
import { AppError } from "../../utils/app.error.js";
import { S3StaticDeploymentExecutor } from "./s3-static-deployment.executor.js";
import { SshEc2ContainerExecutor } from "./ssh-ec2-container.executor.js";

/** Dispatches to the target-specific deployment implementation without adding more queues. */
export class DeployBenchDeploymentExecutor implements DeploymentTargetExecutor {
  private readonly s3Executor = new S3StaticDeploymentExecutor();
  private readonly ec2Executor = new SshEc2ContainerExecutor();

  handlesHealthCheck(environment: DeploymentExecutionInput["environment"]): boolean {
    // EC2 must roll back the old container if health verification fails. Its executor
    // owns that health check; the shared worker must not repeat it without rollback.
    return environment.targetType === "ssh_ec2";
  }

  async deploy(input: DeploymentExecutionInput): Promise<void> {
    switch (input.environment.targetType) {
      case "s3":
        await this.s3Executor.deploy(input);
        return;
      case "ssh_ec2":
        await this.ec2Executor.deploy(input);
        return;
      default: {
        const unsupportedTarget: never = input.environment.targetType;
        throw new AppError(`Unsupported deployment target: ${String(unsupportedTarget)}`, 400);
      }
    }
  }
}

export const createDeploymentExecutor = (): DeploymentTargetExecutor =>
  new DeployBenchDeploymentExecutor();
