import {
  createHash,
} from "node:crypto";

import {
  createReadStream,
  createWriteStream,
} from "node:fs";

import {
  lstat,
  mkdir,
  rm,
} from "node:fs/promises";

import {
  dirname,
} from "node:path";

import {
  finished,
  pipeline,
} from "node:stream/promises";

import {
  Transform,
} from "node:stream";

import type {
  Stats,
} from "node:fs";

import type {
  TransformCallback,
} from "node:stream";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import type {
  NodeJsClient,
} from "@smithy/types";

import { env } from "../config/env.js";
import { AppError } from "../utils/app.error.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type S3UploadResult = {
  bucket: string;
  key: string;
  sizeInBytes: number;
  sha256: string;
};

export type S3DownloadResult = {
  bucket: string;
  key: string;
  sizeInBytes: number;
  sha256: string;
};

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const MAX_S3_BUCKET_NAME_LENGTH = 128;

const MAX_S3_KEY_LENGTH = 1024;

const SHA256_HEX_LENGTH = 64;

/* -------------------------------------------------------------------------- */
/* S3 client                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One shared S3 client for the process.
 *
 * AWS SDK v3 uses the normal credential/provider chain when
 * credentials and region are not explicitly supplied.
 */
const s3Client =
  new S3Client({ region: env.S3_REGION });

/**
 * Node-specific narrowed client.
 *
 * AWS documents this narrowing for streaming GetObject bodies
 * in Node.js.
 */
const nodeS3Client =
  s3Client as NodeJsClient<S3Client>;

/**
 * Close S3 once during application shutdown.
 */
export const closeS3Storage =
  (): void => {
    s3Client.destroy();
  };

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

const normalizeBucketName = (
  bucket: string,
): string => {
  const normalized =
    bucket.trim();

  if (
    normalized.length === 0
  ) {
    throw new AppError(
      "S3 bucket name cannot be empty",
      500,
    );
  }

  if (
    normalized.length >
    MAX_S3_BUCKET_NAME_LENGTH
  ) {
    throw new AppError(
      "S3 bucket name is too long",
      500,
    );
  }

  return normalized;
};

const normalizeObjectKey = (
  key: string,
): string => {
  const normalized =
    key.trim();

  if (
    normalized.length === 0
  ) {
    throw new AppError(
      "S3 object key cannot be empty",
      500,
    );
  }

  if (
    normalized.length >
    MAX_S3_KEY_LENGTH
  ) {
    throw new AppError(
      "S3 object key is too long",
      500,
    );
  }

  return normalized;
};

/* -------------------------------------------------------------------------- */
/* File validation                                                            */
/* -------------------------------------------------------------------------- */

const assertRegularFile =
  async (
    filePath: string,
  ): Promise<Stats> => {
    const normalizedPath =
      filePath.trim();

    if (
      normalizedPath.length === 0
    ) {
      throw new AppError(
        "File path cannot be empty",
        400,
      );
    }

    let stats: Stats;

    try {
      /**
       * lstat() deliberately does NOT follow a symbolic link.
       *
       * Artifact upload should receive the actual produced file,
       * not an unexpected symlink target.
       */
      stats =
        await lstat(
          normalizedPath,
        );
    } catch {
      throw new AppError(
        "Artifact file does not exist",
        404,
      );
    }

    if (
      !stats.isFile()
    ) {
      throw new AppError(
        "Artifact path must point to a regular file",
        400,
      );
    }

    if (
      !Number.isSafeInteger(
        stats.size,
      )
    ) {
      throw new AppError(
        "Artifact file size exceeds JavaScript safe integer range",
        413,
      );
    }

    return stats;
  };

type FileSignature = {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

const getFileSignature = (
  stats: Stats,
): FileSignature => {
  return {
    size:
      stats.size,
    mtimeMs:
      stats.mtimeMs,
    ctimeMs:
      stats.ctimeMs,
  };
};

const sameFileSignature = (
  first: FileSignature,
  second: FileSignature,
): boolean => {
  return (
    first.size ===
      second.size &&
    first.mtimeMs ===
      second.mtimeMs &&
    first.ctimeMs ===
      second.ctimeMs
  );
};

/* -------------------------------------------------------------------------- */
/* Hashing transform                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Passes bytes through unchanged while calculating SHA-256.
 *
 * This lets us:
 *
 * file
 *   ↓
 * hash
 *   ↓
 * S3
 *
 * without loading the entire artifact into memory.
 */
class Sha256Transform extends Transform {
  private readonly hash =
    createHash("sha256");

  private totalBytes = 0;

  private digestValue:
    | string
    | undefined;

  public constructor() {
    super({
      transform: (
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: TransformCallback,
      ): void => {
        try {
          this.hash.update(chunk);

          this.totalBytes +=
            chunk.length;

          callback(
            null,
            chunk,
          );
        } catch (error: unknown) {
          callback(
            error instanceof Error
              ? error
              : new Error(
                  "Failed to process data for SHA-256",
                ),
          );
        }
      },

      flush: (
        callback: TransformCallback,
      ): void => {
        try {
          this.digestValue =
            this.hash.digest("hex");

          callback();
        } catch (error: unknown) {
          callback(
            error instanceof Error
              ? error
              : new Error(
                  "Failed to finalize SHA-256",
                ),
          );
        }
      },
    });
  }

  public getDigest(): string {
    const digest =
      this.digestValue;

    if (digest === undefined) {
      throw new AppError(
        "SHA-256 digest is not finalized",
        500,
      );
    }

    return digest;
  }

  public getTotalBytes(): number {
    return this.totalBytes;
  }
}

/* -------------------------------------------------------------------------- */
/* Upload                                                                     */
/* -------------------------------------------------------------------------- */

export const uploadFileToS3 =
  async ({
    bucket,
    key,
    filePath,
    contentType,
  }: {
    bucket: string;
    key: string;
    filePath: string;
    contentType?: string | null;
  }): Promise<S3UploadResult> => {
    const normalizedBucket =
      normalizeBucketName(
        bucket,
      );

    const normalizedKey =
      normalizeObjectKey(
        key,
      );

    const initialStats =
      await assertRegularFile(
        filePath,
      );

    const initialSignature =
      getFileSignature(
        initialStats,
      );

    const source =
      createReadStream(
        filePath,
      );

    const hashingStream =
      new Sha256Transform();

    /**
     * Propagate source errors into the stream consumed
     * by the S3 SDK.
     */
    source.on(
      "error",
      (error: Error) => {
        hashingStream.destroy(
          error,
        );
      },
    );

    source.pipe(
      hashingStream,
    );

    try {
      await nodeS3Client.send(
        new PutObjectCommand({
          Bucket:
            normalizedBucket,

          Key:
            normalizedKey,

          /**
           * Passing ContentLength is useful because the exact
           * local file size is already known.
           */
          ContentLength:
            initialStats.size,

          Body:
            hashingStream,

          ...(contentType
            ? {
                ContentType:
                  contentType,
              }
            : {}),
        }),
      );

      /**
       * Make sure the transform has completely processed the
       * uploaded stream and finalized the hash.
       */
      await finished(
        hashingStream,
      );

      const uploadedBytes =
        hashingStream.getTotalBytes();

      if (
        uploadedBytes !==
        initialStats.size
      ) {
        /**
         * The source changed or the stream was not what we expected.
         */
        await deleteObjectFromS3({
          bucket:
            normalizedBucket,
          key:
            normalizedKey,
        });

        throw new AppError(
          "Artifact size changed during upload",
          409,
        );
      }

      /**
       * Verify the source was not modified while uploading.
       */
      const finalStats =
        await assertRegularFile(
          filePath,
        );

      const finalSignature =
        getFileSignature(
          finalStats,
        );

      if (
        !sameFileSignature(
          initialSignature,
          finalSignature,
        )
      ) {
        /**
         * S3 already contains an object, so remove it.
         */
        await deleteObjectFromS3({
          bucket:
            normalizedBucket,
          key:
            normalizedKey,
        });

        throw new AppError(
          "Artifact source file changed during upload",
          409,
        );
      }

      return {
        bucket:
          normalizedBucket,

        key:
          normalizedKey,

        sizeInBytes:
          uploadedBytes,

        sha256:
          hashingStream.getDigest(),
      };
    } catch (error: unknown) {
      /**
       * Ensure local streams are closed when S3 fails.
       */
      source.destroy();
      hashingStream.destroy();

      throw error;
    }
  };

/* -------------------------------------------------------------------------- */
/* Download                                                                    */
/* -------------------------------------------------------------------------- */

export const downloadFileFromS3 =
  async ({
    bucket,
    key,
    destinationPath,
  }: {
    bucket: string;
    key: string;
    destinationPath: string;
  }): Promise<S3DownloadResult> => {
    const normalizedBucket =
      normalizeBucketName(
        bucket,
      );

    const normalizedKey =
      normalizeObjectKey(
        key,
      );

    const normalizedDestination =
      destinationPath.trim();

    if (
      normalizedDestination.length ===
      0
    ) {
      throw new AppError(
        "Download destination cannot be empty",
        400,
      );
    }

    await mkdir(
      dirname(
        normalizedDestination,
      ),
      {
        recursive: true,
      },
    );

    const response =
      await nodeS3Client.send(
        new GetObjectCommand({
          Bucket:
            normalizedBucket,

          Key:
            normalizedKey,
        }),
      );

    const body =
      response.Body;

    if (
      body === undefined
    ) {
      throw new AppError(
        "S3 object did not contain a response body",
        502,
      );
    }

    const hashingStream =
      new Sha256Transform();

    const output =
      createWriteStream(
        normalizedDestination,
      );

    try {
      /**
       * Consume the S3 stream instead of buffering the
       * complete object in memory.
       */
      await pipeline(
        body,
        hashingStream,
        output,
      );
    } catch (error: unknown) {
      /**
       * Do not leave a partially downloaded artifact.
       */
      try {
        await rm(
          normalizedDestination,
          {
            force: true,
          },
        );
      } catch {
        // Best-effort cleanup.
      }

      throw error;
    }

    const sizeInBytes =
      hashingStream.getTotalBytes();

    if (
      response.ContentLength !==
        undefined &&
      sizeInBytes !==
        response.ContentLength
    ) {
      try {
        await rm(
          normalizedDestination,
          {
            force: true,
          },
        );
      } catch {
        // Best-effort cleanup.
      }

      throw new AppError(
        "Downloaded S3 object size does not match S3 metadata",
        502,
      );
    }

    return {
      bucket:
        normalizedBucket,

      key:
        normalizedKey,

      sizeInBytes,

      sha256:
        hashingStream.getDigest(),
    };
  };

/* -------------------------------------------------------------------------- */
/* Delete                                                                     */
/* -------------------------------------------------------------------------- */

export const deleteObjectFromS3 =
  async ({
    bucket,
    key,
  }: {
    bucket: string;
    key: string;
  }): Promise<void> => {
    const normalizedBucket =
      normalizeBucketName(
        bucket,
      );

    const normalizedKey =
      normalizeObjectKey(
        key,
      );

    await nodeS3Client.send(
      new DeleteObjectCommand({
        Bucket:
          normalizedBucket,

        Key:
          normalizedKey,
      }),
    );
  };


