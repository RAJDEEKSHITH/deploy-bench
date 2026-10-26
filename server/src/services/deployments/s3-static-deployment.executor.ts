import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import * as yauzl from "yauzl";

import { env } from "../../config/env.js";
import type {
  DeploymentExecutionInput,
  DeploymentTargetExecutor,
} from "../../workers/deployment.worker.js";
import { downloadArtifactToFile } from "../artifacs/artifacts.service.js";
import { AppError } from "../../utils/app.error.js";
import { resolveEnvironmentS3Credentials } from "./deployment-credentials.service.js";

const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 250 * 1024 * 1024;
const MAX_FILES = 25_000;
const MAX_TOTAL_EXTRACTED_BYTES = 1024 * 1024 * 1024;
const DELETE_BATCH_SIZE = 1_000;

interface S3TargetConfig {
  bucketName: string;
  region: string;
  prefix: string;
}

interface ExtractedFile {
  absolutePath: string;
  relativePath: string;
  size: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const getRequiredString = (
  config: Record<string, unknown>,
  key: string,
  maxLength: number,
): string => {
  const value = config[key];
  if (typeof value !== "string") {
    throw new AppError(`S3 targetConfig.${key} must be a string`, 400);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new AppError(`S3 targetConfig.${key} is empty or too long`, 400);
  }
  return normalized;
};

const parseS3TargetConfig = (input: unknown): S3TargetConfig => {
  if (!isRecord(input)) {
    throw new AppError("S3 environment targetConfig must be an object", 400);
  }

  const bucketName = getRequiredString(input, "bucketName", 63).toLowerCase();
  const region = getRequiredString(input, "region", 100);
  const rawPrefix = getRequiredString(input, "prefix", 512);

  if (
    bucketName.length < 3 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucketName) ||
    bucketName.includes("..") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucketName)
  ) {
    throw new AppError("S3 target bucket name is invalid", 400);
  }
  if (!/^[a-z0-9-]+$/.test(region)) {
    throw new AppError("S3 target region is invalid", 400);
  }

  // Use '.' only as an explicit opt-in to bucket-root sync. In that case the
  // target bucket must be dedicated to this site (never the artifact/log bucket).
  const bucketRootRequested = rawPrefix === ".";
  const prefixWithoutTrailingSlash = bucketRootRequested ? "" : rawPrefix.replace(/\/+$/, "");
  if (
    (!bucketRootRequested && prefixWithoutTrailingSlash.length === 0) ||
    prefixWithoutTrailingSlash.startsWith("/") ||
    prefixWithoutTrailingSlash.includes("\\") ||
    prefixWithoutTrailingSlash.includes(":") ||
    (!bucketRootRequested && prefixWithoutTrailingSlash.split("/").some((part) => part.length === 0 || part === "." || part === ".."))
  ) {
    throw new AppError("S3 prefix must be a relative path such as 'site', or '.' for an explicitly dedicated bucket root", 400);
  }

  if (
    bucketName === env.S3_ARTIFACTS_BUCKET.toLowerCase() ||
    bucketName === env.S3_LOGS_BUCKET.toLowerCase()
  ) {
    throw new AppError("Deployment target bucket must differ from artifact and log storage buckets", 400);
  }

  return { bucketName, region, prefix: bucketRootRequested ? "" : `${prefixWithoutTrailingSlash}/` };
};

const safeArchivePath = (entryName: string): { relativePath: string; isDirectory: boolean } => {
  if (
    entryName.length === 0 ||
    entryName.includes("\0") ||
    entryName.includes("\\") ||
    entryName.includes(":") ||
    entryName.startsWith("/") ||
    /^[A-Za-z]:/.test(entryName) ||
    /[\u0000-\u001f\u007f]/.test(entryName)
  ) {
    throw new AppError("Artifact ZIP contains an unsafe file path", 400);
  }

  const isDirectory = entryName.endsWith("/");
  const trimmed = isDirectory ? entryName.slice(0, -1) : entryName;
  const segments = trimmed.split("/");
  if (
    trimmed.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new AppError("Artifact ZIP contains a path traversal or empty path segment", 400);
  }

  const normalized = segments.join("/");
  if (normalized === "" || normalized.startsWith("../") || isAbsolute(normalized)) {
    throw new AppError("Artifact ZIP contains an unsafe file path", 400);
  }
  return { relativePath: normalized, isDirectory };
};

const unzipArchiveSafely = async (archivePath: string, outputDirectory: string): Promise<void> => {
  const stats = await lstat(archivePath);
  if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_ARCHIVE_BYTES) {
    throw new AppError("Deployment artifact ZIP is empty or exceeds the 1 GiB compressed size limit", 413);
  }

  const zipFile = await new Promise<yauzl.ZipFile>((resolveZip, rejectZip) => {
    yauzl.open(
      archivePath,
      {
        lazyEntries: true,
        autoClose: false,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
      },
      (error: Error | null, openedZip: yauzl.ZipFile) => {
        if (error) {
          rejectZip(new AppError(`Cannot open deployment artifact ZIP: ${error.message}`, 400));
          return;
        }
        if (!openedZip) {
          rejectZip(new AppError("Cannot open deployment artifact ZIP", 400));
          return;
        }
        resolveZip(openedZip);
      },
    );
  });

  await new Promise<void>((resolveExtraction, rejectExtraction) => {
    let settled = false;
    let fileCount = 0;
    let totalExtractedBytes = 0;
    const seenPaths = new Set<string>();

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      zipFile.close();
      rejectExtraction(error instanceof Error ? error : new Error("ZIP extraction failed"));
    };

    zipFile.on("error", fail);
    zipFile.on("end", () => {
      if (settled) return;
      settled = true;
      zipFile.close();
      resolveExtraction();
    });

    zipFile.on("entry", (entry: yauzl.Entry) => {
      void (async () => {
        try {
          if ((entry.generalPurposeBitFlag & (0x1 | 0x40)) !== 0) {
            throw new AppError("Encrypted deployment ZIPs are not supported", 400);
          }

          // ZIP external attributes may mark an entry as a Unix symlink. Never extract links.
          const unixFileType = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (unixFileType === 0o120000) {
            throw new AppError("Deployment ZIPs must not contain symbolic links", 400);
          }

          const { relativePath, isDirectory } = safeArchivePath(entry.fileName);
          const collisionKey = relativePath.toLocaleLowerCase("en-US");
          if (seenPaths.has(collisionKey)) {
            throw new AppError(`Deployment ZIP contains a duplicate path: ${relativePath}`, 400);
          }
          seenPaths.add(collisionKey);

          const outputPath = resolve(outputDirectory, ...relativePath.split("/"));
          const relativeOutput = relative(outputDirectory, outputPath);
          if (
            relativeOutput === ".." ||
            relativeOutput.startsWith(`..${sep}`) ||
            isAbsolute(relativeOutput)
          ) {
            throw new AppError("Deployment ZIP path escapes the extraction directory", 400);
          }

          if (isDirectory) {
            await mkdir(outputPath, { recursive: true, mode: 0o700 });
            if (!settled) zipFile.readEntry();
            return;
          }

          if (
            !Number.isSafeInteger(entry.uncompressedSize) ||
            entry.uncompressedSize > MAX_FILE_BYTES
          ) {
            throw new AppError(`Deployment ZIP entry exceeds the ${MAX_FILE_BYTES} byte per-file limit`, 413);
          }
          fileCount += 1;
          totalExtractedBytes += entry.uncompressedSize;
          if (fileCount > MAX_FILES || totalExtractedBytes > MAX_TOTAL_EXTRACTED_BYTES) {
            throw new AppError("Deployment ZIP exceeds file-count or total extracted size limits", 413);
          }

          await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
          const inputStream = await new Promise<NodeJS.ReadableStream>((resolveStream, rejectStream) => {
            zipFile.openReadStream(
              entry,
              (
                error: Error | null,
                stream: NodeJS.ReadableStream | undefined,
              ) => {
                if (error) {
                  rejectStream(error);
                  return;
                }
                if (!stream) {
                  rejectStream(new Error("Could not read ZIP entry stream"));
                  return;
                }
                resolveStream(stream);
              },
            );
          });
          let actualEntryBytes = 0;
          const sizeLimit = new Transform({
            transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
              actualEntryBytes += chunk.length;
              if (actualEntryBytes > entry.uncompressedSize || actualEntryBytes > MAX_FILE_BYTES) {
                callback(new AppError("ZIP entry expanded beyond its declared or allowed size", 413));
                return;
              }
              callback(null, chunk);
            },
          });
          await pipeline(
            inputStream,
            sizeLimit,
            createWriteStream(outputPath, { flags: "wx", mode: 0o600 }),
          );
          if (actualEntryBytes !== entry.uncompressedSize) {
            throw new AppError("ZIP entry size does not match its metadata", 400);
          }
          if (!settled) zipFile.readEntry();
        } catch (error: unknown) {
          fail(error);
        }
      })();
    });

    zipFile.readEntry();
  });
};

const listExtractedFiles = async (rootDirectory: string): Promise<ExtractedFile[]> => {
  const files: ExtractedFile[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        throw new AppError("Extracted deployment tree unexpectedly contains a symbolic link", 500);
      }
      if (stats.isDirectory()) {
        await walk(absolutePath);
      } else if (stats.isFile()) {
        const relativePath = relative(rootDirectory, absolutePath).split(sep).join("/");
        files.push({ absolutePath, relativePath, size: stats.size });
      } else {
        throw new AppError("Extracted deployment tree contains an unsupported filesystem entry", 500);
      }
    }
  };
  await walk(rootDirectory);
  files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  if (files.length === 0) {
    throw new AppError("Deployment artifact ZIP does not contain any files", 400);
  }
  if (!files.some((file) => file.relativePath === "index.html")) {
    throw new AppError("S3 static site artifact must contain index.html at the ZIP root", 400);
  }
  return files;
};

const getContentType = (filePath: string): string => {
  switch (extname(filePath).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js":
    case ".mjs": return "text/javascript; charset=utf-8";
    case ".json":
    case ".map": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".txt": return "text/plain; charset=utf-8";
    case ".xml": return "application/xml; charset=utf-8";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".ico": return "image/x-icon";
    case ".pdf": return "application/pdf";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    case ".ttf": return "font/ttf";
    case ".wasm": return "application/wasm";
    default: return "application/octet-stream";
  }
};

const listKeys = async (
  client: S3Client,
  bucketName: string,
  prefix: string,
  signal: AbortSignal,
): Promise<string[]> => {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix,
      ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
    }), { abortSignal: signal });
    for (const item of response.Contents ?? []) {
      if (typeof item.Key === "string" && item.Key.startsWith(prefix)) keys.push(item.Key);
    }
    if (response.IsTruncated === true && !response.NextContinuationToken) {
      throw new AppError("S3 did not return a continuation token for a truncated listing", 502);
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken !== undefined);
  return keys;
};

const deleteStaleKeys = async (
  client: S3Client,
  bucketName: string,
  staleKeys: string[],
  signal: AbortSignal,
): Promise<void> => {
  for (let offset = 0; offset < staleKeys.length; offset += DELETE_BATCH_SIZE) {
    const batch = staleKeys.slice(offset, offset + DELETE_BATCH_SIZE);
    const response = await client.send(new DeleteObjectsCommand({
      Bucket: bucketName,
      Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
    }), { abortSignal: signal });
    if ((response.Errors?.length ?? 0) > 0) {
      const failed = response.Errors?.slice(0, 3).map((item) => `${item.Key ?? "unknown"}: ${item.Message ?? "delete failed"}`).join("; ");
      throw new AppError(`Failed to delete stale S3 objects: ${failed ?? "unknown S3 deletion error"}`, 502);
    }
  }
};

export class S3StaticDeploymentExecutor implements DeploymentTargetExecutor {
  async deploy(input: DeploymentExecutionInput): Promise<void> {
    const { deployment, environment, artifact, signal } = input;
    if (environment.targetType !== "s3") {
      throw new AppError("S3 executor received a non-S3 environment", 500);
    }
    if (!artifact || artifact.id !== deployment.artifactId || artifact.kind !== "archive") {
      throw new AppError("S3 deployment requires a ready archive artifact", 409);
    }
    if (signal.aborted) throw new AppError("Deployment was canceled before S3 sync", 499);

    const config = parseS3TargetConfig(environment.targetConfig);
    const credentials = await resolveEnvironmentS3Credentials(
      environment.projectId,
      environment.id,
    );
    const client = new S3Client({
      region: config.region,
      credentials,
    });
    let temporaryDirectory: string | null = null;

    try {
      temporaryDirectory = await mkdtemp(join(tmpdir(), "deploybench-s3-deploy-"));
      const archivePath = join(temporaryDirectory, "artifact.zip");
      const extractedDirectory = join(temporaryDirectory, "extracted");
      await mkdir(extractedDirectory, { recursive: true, mode: 0o700 });
      const downloaded = await downloadArtifactToFile({
        artifactId: artifact.id,
        destinationPath: archivePath,
      });
      if (downloaded.artifact.sha256 !== artifact.sha256) {
        throw new AppError("Artifact metadata changed while deployment was being prepared", 409);
      }
      await unzipArchiveSafely(archivePath, extractedDirectory);
      const files = await listExtractedFiles(extractedDirectory);
      if (signal.aborted) throw new AppError("Deployment was canceled before S3 upload", 499);

      const newKeys = new Set<string>();
      for (const file of files) {
        if (signal.aborted) throw new AppError("Deployment was canceled during S3 upload", 499);
        const key = `${config.prefix}${file.relativePath}`;
        newKeys.add(key);
        await client.send(new PutObjectCommand({
          Bucket: config.bucketName,
          Key: key,
          Body: createReadStream(file.absolutePath),
          ContentLength: file.size,
          ContentType: getContentType(file.relativePath),
          CacheControl: file.relativePath.toLowerCase().endsWith(".html")
            ? "no-cache, max-age=0, must-revalidate"
            : "public, max-age=300",
          Metadata: {
            "deploybench-deployment-id": deployment.id,
            "deploybench-commit-sha": deployment.commitSha,
          },
        }), { abortSignal: signal });
      }

      // Only delete stale objects after all current files have uploaded successfully.
      // Deletion is bounded to the dedicated prefix and never touches other bucket paths.
      if (signal.aborted) throw new AppError("S3 deployment was canceled before stale-file cleanup", 499);
      const existingKeys = await listKeys(client, config.bucketName, config.prefix, signal);
      const staleKeys = existingKeys.filter((key) => !newKeys.has(key));
      if (staleKeys.length > 0) {
        await deleteStaleKeys(client, config.bucketName, staleKeys, signal);
      }
    } finally {
      client.destroy();
      if (temporaryDirectory !== null) {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch((error: unknown) => {
          console.error("Failed to clean temporary S3 deployment workspace", {
            deploymentId: deployment.id,
            temporaryDirectory: basename(temporaryDirectory ?? ""),
            error,
          });
        });
      }
    }
  }
}
