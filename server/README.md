# DeployBench Express smoke test

A minimal Express app intended to test the DeployBench Docker -> ECR -> EC2 deployment path without a database, Redis, AWS SDK, or application-specific `.env` variables.

## Files

- `app.js`: Express app with `/` and `/health` routes.
- `Dockerfile`: Packages Node.js 22 and production dependencies into the image.
- `.dockerignore`: Excludes local dependencies and environment files.
- `.cicd/pipeline.yaml`: Pipeline template using the ECR registry/repository already provided.

## Important: use a separate branch

This sample is designed to replace the root `app.js`, `package.json`, `Dockerfile`, `.dockerignore`, and `.cicd/pipeline.yaml` **on a test branch only**. Do not replace those files on your real backend's `main` branch.

From Git Bash, in your existing repository:

```bash
git switch main
git pull
git switch -c deploybench-express-smoke
```

Extract/copy the contents of this ZIP into that repository root, allowing those files to be replaced on this new branch. The `main` branch remains unchanged.

Generate the lockfile and install local dependencies:

```bash
npm install
```

Commit and push only the test files:

```bash
git add app.js package.json package-lock.json Dockerfile .dockerignore .cicd/pipeline.yaml
git commit -m "Add minimal Express deployment smoke test"
git push -u origin deploybench-express-smoke
```

The pipeline assumes `containerImage` support is present in your DeployBench version and that the ECR repository exists and the project-scoped `ECR_AWS_ACCESS_KEY_ID` and `ECR_AWS_SECRET_ACCESS_KEY` secrets have permission to push to it.

## DeployBench settings

- Build pipeline image repository: `deploybench/backend` in account `461625528221`, region `ap-south-1`.
- Set the EC2 environment's deployment branch to `deploybench-express-smoke` for this test.
- SSH target port: `22`; SSH username: `ubuntu`.
- EC2 host port and container port: `3000` and `3000`.
- Health-check URL: `http://52.66.50.189:3000/health` (adjust if the instance's public IP changes).
- Ensure Docker Engine is installed and running on EC2.
- Ensure the EC2 security group permits inbound TCP `3000` from the machine running the DeployBench worker (for this setup, usually your current public IP), preferably restricted to that IP.
- Make sure the DeployBench environment's SSH hostname matches the hostname form in `DEPLOYBENCH_SSH_KNOWN_HOSTS`; if the `host` is the DNS hostname, use that DNS hostname in the health check too if desired.

## Verify

After the image is successfully published, deploy it manually from the environment's **Deploy** action, selecting the smoke-test run/image.

Expected response at `/health`:

```json
{"status":"ok"}
```

Root endpoint `/` returns `DeployBench Express smoke test is running.`

This sample tests manual deployment. It does not by itself implement automatic deployment after every successful pipeline run.
