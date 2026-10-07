import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { AppError } from "../../utils/app.error.js";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 120_000;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const MAX_ERROR_LENGTH = 2_000;

export const MAX_REPOSITORY_FILE_BYTES = 1024 * 1024;
// Must match projects.pipeline_path / pipeline_versions.path (varchar 512).
export const MAX_REPOSITORY_FILE_PATH_LENGTH = 512;

const COMMIT_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const GITHUB_REPOSITORY_PATH_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export const normalizeCommitSha = (commitSha: string): string => {
  const sha = commitSha.toLowerCase();

  if (!COMMIT_SHA_PATTERN.test(sha)) {
    throw new AppError("Invalid repository commit SHA", 400);
  }

  return sha;
};

/**
 * Accepts only plain https://github.com/owner/repo(.git) URLs and returns the
 * canonical clone URL. Tokens are never allowed inside the URL.
 */
export const normalizeRepositoryUrl = (repositoryUrl: string): string => {
  let url: URL;

  try {
    url = new URL(repositoryUrl);
  } catch {
    throw new AppError("Invalid GitHub repository URL", 400);
  }

  const isPlainGithubUrl =
    url.protocol === "https:" &&
    url.hostname.toLowerCase() === "github.com" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "";

  if (!isPlainGithubUrl) {
    throw new AppError("Repository URL must be a plain https://github.com/owner/repo URL", 400);
  }

  const repositoryPath = url.pathname.replace(/^\/|\/$/g, "").replace(/\.git$/i, "");

  if (!GITHUB_REPOSITORY_PATH_PATTERN.test(repositoryPath)) {
    throw new AppError("Invalid GitHub repository path", 400);
  }

  return `https://github.com/${repositoryPath}.git`;
};

export const normalizeRepositoryFilePath = (filePath: string): string => {
  if (filePath.length === 0 || filePath.length > MAX_REPOSITORY_FILE_PATH_LENGTH) {
    throw new AppError("Invalid repository file path", 400);
  }

  if (/\p{Cc}/u.test(filePath)) {
    throw new AppError("Repository file path contains invalid characters", 400);
  }

  // Git paths always use '/'.
  const normalized = posix.normalize(filePath.replaceAll("\\", "/"));

  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.endsWith("/")
  ) {
    throw new AppError("Repository file path must be a file inside the repository", 400);
  }

  return normalized;
};

/* -------------------------------------------------------------------------- */
/* Git runner                                                                 */
/* -------------------------------------------------------------------------- */

type GitOptions = {
  cwd?: string | undefined;
  accessToken?: string | undefined;
  maxBuffer?: number | undefined;
};

const encodeBasicAuth = (token: string): string =>
  Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");

const sanitizeError = (error: unknown, token?: string | undefined): string => {
  let message = error instanceof Error ? error.message : "Git command failed";

  if (token) {
    message = message
      .replaceAll(token, "[REDACTED]")
      .replaceAll(encodeBasicAuth(token), "[REDACTED]");
  }

  return message.slice(0, MAX_ERROR_LENGTH);
};

const runGit = async (
  args: readonly string[],
  { cwd, accessToken, maxBuffer = MAX_GIT_OUTPUT_BYTES }: GitOptions = {},
): Promise<string> => {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0", // never wait for interactive credentials
    GIT_ALLOW_PROTOCOL: "https", // defense in depth: no ssh/file/ext transports
  };

  // Runtime-only config: the token never appears in argv or .git/config,
  // and the header is scoped to github.com only.
  if (accessToken) {
    environment.GIT_CONFIG_COUNT = "1";
    environment.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraHeader";
    environment.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: Basic ${encodeBasicAuth(accessToken)}`;
  }

  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd,
      env: environment,
      encoding: "utf8",
      maxBuffer,
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
      windowsHide: true,
    });

    return stdout;
  } catch (error) {
    throw new AppError(sanitizeError(error, accessToken), 500);
  }
};

/* -------------------------------------------------------------------------- */
/* Workspace                                                                  */
/* -------------------------------------------------------------------------- */

export type RepositoryWorkspace = {
  path: string;
  commitSha: string;
  cleanup: () => Promise<void>;
};

export type CloneRepositoryAtCommitInput = {
  repositoryUrl: string;
  commitSha: string;
  accessToken?: string | undefined;
  /** Populate the working tree. Not needed just to read files. Default: true. */
  checkout?: boolean | undefined;
};

/**
 * Fetches exactly one commit (shallow, no history) into a temp directory.
 * Never builds the moving branch name: the SHA is the immutable source.
 */
export const cloneRepositoryAtCommit = async ({
  repositoryUrl,
  commitSha,
  accessToken,
  checkout = true,
}: CloneRepositoryAtCommitInput): Promise<RepositoryWorkspace> => {
  const url = normalizeRepositoryUrl(repositoryUrl);
  const sha = normalizeCommitSha(commitSha);

  if (accessToken !== undefined && accessToken.trim().length === 0) {
    throw new AppError("GitHub access token cannot be empty", 500);
  }

  const workspacePath = await mkdtemp(join(tmpdir(), "deploybench-repository-"));
  const cleanup = (): Promise<void> => rm(workspacePath, { recursive: true, force: true });

  try {
    await runGit(["init", "--quiet", workspacePath]);
    await runGit(["remote", "add", "origin", url], { cwd: workspacePath });

    // GitHub allows fetching a reachable commit by full SHA.
    await runGit(["fetch", "--quiet", "--no-tags", "--depth=1", "origin", sha], {
      cwd: workspacePath,
      accessToken,
    });

    const resolved = (
      await runGit(["rev-parse", "--verify", `${sha}^{commit}`], { cwd: workspacePath })
    )
      .trim()
      .toLowerCase();

    if (resolved !== sha) {
      throw new AppError("Fetched object does not match the requested commit", 500);
    }

    if (checkout) {
      await runGit(["checkout", "--quiet", "--detach", "--force", sha], { cwd: workspacePath });
    }

    return { path: workspacePath, commitSha: sha, cleanup };
  } catch (error) {
    await cleanup();

    if (error instanceof AppError) throw error;
    throw new AppError("Failed to prepare repository", 500);
  }
};

export type ReadFileAtCommitInput = {
  workspacePath: string;
  commitSha: string;
  filePath: string;
};

/**
 * Reads a regular file at an exact commit.
 * Returns null if the path does not exist at that commit.
 */
export const readFileAtCommit = async ({
  workspacePath,
  commitSha,
  filePath,
}: ReadFileAtCommitInput): Promise<string | null> => {
  const sha = normalizeCommitSha(commitSha);
  const path = normalizeRepositoryFilePath(filePath);

  // One command gives existence, object type and size:
  // "<mode> <type> <object> <size>\t<path>"
  const listing = await runGit(["ls-tree", "--long", sha, "--", path], { cwd: workspacePath });
  const match = /^(\d{6}) (\w+) [0-9a-f]+ +(\d+|-)\t/.exec(listing.split("\n", 1)[0] ?? "");

  if (!match) return null;

  const [, mode, type, size] = match;

  // 120000 = symlink, 160000 = submodule, tree = directory.
  if (type !== "blob" || mode === "120000") {
    throw new AppError("Repository path is not a regular file", 400);
  }

  if (Number(size) > MAX_REPOSITORY_FILE_BYTES) {
    throw new AppError("Repository file is too large", 400);
  }

  return runGit(["cat-file", "blob", `${sha}:${path}`], {
    cwd: workspacePath,
    maxBuffer: MAX_REPOSITORY_FILE_BYTES + 1024,
  });
};

export const withRepositoryAtCommit = async <T>(
  input: CloneRepositoryAtCommitInput,
  operation: (workspace: RepositoryWorkspace) => Promise<T>,
): Promise<T> => {
  const workspace = await cloneRepositoryAtCommit(input);

  try {
    return await operation(workspace);
  } finally {
    await workspace.cleanup();
  }
};