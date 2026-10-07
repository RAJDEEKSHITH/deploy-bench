import {
  createWriteStream,
} from "node:fs";

import {
  lstat,
  mkdtemp,
  rm,
} from "node:fs/promises";

import {
  finished,
} from "node:stream/promises";

import {
  join,
} from "node:path";

import {
  and,
  desc,
  eq,
} from "drizzle-orm";

import {
  ZipArchive,
} from "@archiver/archiver";

import { db } from "../../db/index.js";

import {
  artifacts,
  jobAttempts,
  jobs,
  runs,
} from "../../db/schema.js";

import { AppError } from "../../utils/app.error.js";

import {
  deleteObjectFromS3,
  downloadFileFromS3,
  uploadFileToS3,
} from "../../storage/s3.service.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type Artifact =
  typeof artifacts.$inferSelect;

export type ArtifactKind =
  typeof artifacts.$inferInsert["kind"];

export type CreateArtifactFromFileInput = {
  runId: string;

  name: string;

  kind: ArtifactKind;

  localFilePath: string;

  s3BucketName: string;

  contentType?: string | null;

  producerJobId?: string | null;

  producerJobAttemptId?:
    | string
    | null;

  expiresAt?: Date | null;
};

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_ARTIFACT_NAME_LENGTH =
  128;

const MAX_CONTENT_TYPE_LENGTH =
  255;

const MAX_BUCKET_LENGTH =
  128;

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

const normalizeUuid = (
  value: string,
  fieldName: string,
): string => {
  const normalized =
    value.trim();

  if (
    !UUID_REGEX.test(
      normalized,
    )
  ) {
    throw new AppError(
      `${fieldName} must be a valid UUID`,
      400,
    );
  }

  return normalized;
};

const normalizeArtifactName = (
  value: string,
): string => {
  const normalized =
    value.trim();

  if (
    normalized.length === 0
  ) {
    throw new AppError(
      "Artifact name cannot be empty",
      400,
    );
  }

  /**
   * Array.from counts Unicode code points instead of UTF-16
   * code units.
   */
  if (
    Array.from(
      normalized,
    ).length >
    MAX_ARTIFACT_NAME_LENGTH
  ) {
    throw new AppError(
      "Artifact name is too long",
      400,
    );
  }

  return normalized;
};

const normalizeBucketName = (
  value: string,
): string => {
  const normalized =
    value.trim();

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
    MAX_BUCKET_LENGTH
  ) {
    throw new AppError(
      "S3 bucket name is too long",
      500,
    );
  }

  return normalized;
};

const normalizeContentType = (
  value:
    | string
    | null
    | undefined,
): string | null => {
  if (
    value ===
      undefined ||
    value === null
  ) {
    return null;
  }

  const normalized =
    value.trim();

  if (
    normalized.length === 0
  ) {
    return null;
  }

  if (
    normalized.length >
    MAX_CONTENT_TYPE_LENGTH
  ) {
    throw new AppError(
      "Content type is too long",
      400,
    );
  }

  return normalized;
};

const assertArtifactKind = (
  kind: ArtifactKind,
): void => {
  if (
    kind !== "archive" &&
    kind !== "file"
  ) {
    throw new AppError(
      `Unsupported artifact kind: ${String(kind)}`,
      400,
    );
  }
};

const assertExpiration = (
  expiresAt:
    | Date
    | null
    | undefined,
): void => {
  if (
    expiresAt ===
      undefined ||
    expiresAt ===
      null
  ) {
    return;
  }

  if (
    Number.isNaN(
      expiresAt.getTime(),
    )
  ) {
    throw new AppError(
      "expiresAt is invalid",
      400,
    );
  }

  if (
    expiresAt.getTime() <=
    Date.now()
  ) {
    throw new AppError(
      "expiresAt must be in the future",
      400,
    );
  }
};

/* -------------------------------------------------------------------------- */
/* Error helpers                                                              */
/* -------------------------------------------------------------------------- */

const isUniqueViolation = (
  error: unknown,
): boolean => {
  const visited =
    new Set<object>();

  let current:
    | unknown =
    error;

  while (
    current !== null &&
    typeof current ===
      "object"
  ) {
    if (
      visited.has(
        current,
      )
    ) {
      return false;
    }

    visited.add(
      current,
    );

    if (
      "code" in current &&
      (
        current as {
          code?: unknown;
        }
      ).code ===
        "23505"
    ) {
      return true;
    }

    if (
      !("cause" in current)
    ) {
      return false;
    }

    current = (
      current as {
        cause?: unknown;
      }
    ).cause;
  }

  return false;
};

/* -------------------------------------------------------------------------- */
/* Name sanitization                                                          */
/* -------------------------------------------------------------------------- */

const sanitizeArtifactName =
  (
    name: string,
  ): string => {
    const normalized =
      name
        .normalize(
          "NFKC",
        )
        .replace(
          /[\\/]+/g,
          "-",
        )
        .replace(
          /[^\p{L}\p{N}._-]+/gu,
          "-",
        )
        .replace(
          /-+/g,
          "-",
        )
        .replace(
          /^[.-]+/,
          "",
        )
        .replace(
          /[.-]+$/,
          "",
        );

    if (
      normalized.length ===
      0
    ) {
      return "artifact";
    }

    /**
     * Keep object-key filename bounded.
     */
    return Array.from(
      normalized,
    )
      .slice(
        0,
        MAX_ARTIFACT_NAME_LENGTH,
      )
      .join("");
  };

/* -------------------------------------------------------------------------- */
/* S3 object key                                                              */
/* -------------------------------------------------------------------------- */

const buildArtifactObjectKey =
  ({
    projectId,
    runId,
    artifactId,
    name,
  }: {
    projectId: string;
    runId: string;
    artifactId: string;
    name: string;
  }): string => {
    const sanitizedName =
      sanitizeArtifactName(
        name,
      );

    return [
      "projects",
      projectId,
      "runs",
      runId,
      "artifacts",
      `${artifactId}-${sanitizedName}`,
    ].join("/");
  };

/* -------------------------------------------------------------------------- */
/* Run lookup                                                                 */
/* -------------------------------------------------------------------------- */

const getRunContext = async (
  runId: string,
): Promise<{
  runId: string;
  projectId: string;
}> => {
  const [run] =
    await db
      .select({
        runId:
          runs.id,
        projectId:
          runs.projectId,
      })
      .from(runs)
      .where(
        eq(
          runs.id,
          runId,
        ),
      )
      .limit(1);

  if (!run) {
    throw new AppError(
      "Run not found",
      404,
    );
  }

  return run;
};

/* -------------------------------------------------------------------------- */
/* Producer validation                                                        */
/* -------------------------------------------------------------------------- */

const assertProducerConsistency =
  ({
    producerJobId,
    producerJobAttemptId,
  }: {
    producerJobId:
      | string
      | null
      | undefined;

    producerJobAttemptId:
      | string
      | null
      | undefined;
  }): void => {
    const hasJob =
      producerJobId !==
      undefined &&
      producerJobId !==
      null;

    const hasAttempt =
      producerJobAttemptId !==
      undefined &&
      producerJobAttemptId !==
      null;

    if (
      hasJob !== hasAttempt
    ) {
      throw new AppError(
        "producerJobId and producerJobAttemptId must be provided together",
        400,
      );
    }
  };

const assertProducerBelongsToRun =
  async ({
    runId,
    producerJobId,
    producerJobAttemptId,
  }: {
    runId: string;
    producerJobId: string;
    producerJobAttemptId: string;
  }): Promise<void> => {
    const [producer] =
      await db
        .select({
          jobId:
            jobs.id,
          attemptId:
            jobAttempts.id,
        })
        .from(jobAttempts)
        .innerJoin(
          jobs,
          eq(
            jobAttempts.jobId,
            jobs.id,
          ),
        )
        .where(
          and(
            eq(
              jobs.id,
              producerJobId,
            ),
            eq(
              jobs.runId,
              runId,
            ),
            eq(
              jobAttempts.id,
              producerJobAttemptId,
            ),
          ),
        )
        .limit(1);

    if (!producer) {
      throw new AppError(
        "Producer job attempt does not belong to the specified run",
        400,
      );
    }
  };

/* -------------------------------------------------------------------------- */
/* Create artifact from local file                                            */
/* -------------------------------------------------------------------------- */

export const createArtifactFromFile =
  async ({
    runId,
    name,
    kind,
    localFilePath,
    s3BucketName,
    contentType = null,
    producerJobId = null,
    producerJobAttemptId = null,
    expiresAt = null,
  }: CreateArtifactFromFileInput): Promise<Artifact> => {
    const normalizedRunId =
      normalizeUuid(
        runId,
        "runId",
      );

    const normalizedName =
      normalizeArtifactName(
        name,
      );

    const normalizedBucket =
      normalizeBucketName(
        s3BucketName,
      );

    const normalizedContentType =
      normalizeContentType(
        contentType,
      );

    assertArtifactKind(
      kind,
    );

    assertExpiration(
      expiresAt,
    );

    /**
     * Validate the source file BEFORE creating the DB row.
     */
    const sourceStats =
      await lstat(
        localFilePath,
      );

    if (
      !sourceStats.isFile()
    ) {
      throw new AppError(
        "Artifact source must be a regular file",
        400,
      );
    }

    if (
      !Number.isSafeInteger(
        sourceStats.size,
      )
    ) {
      throw new AppError(
        "Artifact size exceeds JavaScript safe integer range",
        413,
      );
    }

    const run =
      await getRunContext(
        normalizedRunId,
      );

    assertProducerConsistency({
      producerJobId,
      producerJobAttemptId,
    });

    const normalizedProducerJobId =
      producerJobId === null ||
      producerJobId ===
        undefined
        ? null
        : normalizeUuid(
            producerJobId,
            "producerJobId",
          );

    const normalizedProducerJobAttemptId =
      producerJobAttemptId ===
        null ||
      producerJobAttemptId ===
        undefined
        ? null
        : normalizeUuid(
            producerJobAttemptId,
            "producerJobAttemptId",
          );

    if (
      normalizedProducerJobId !==
        null &&
      normalizedProducerJobAttemptId !==
        null
    ) {
      await assertProducerBelongsToRun(
        {
          runId:
            normalizedRunId,

          producerJobId:
            normalizedProducerJobId,

          producerJobAttemptId:
            normalizedProducerJobAttemptId,
        },
      );
    }

    /**
     * Insert first because artifact ID is required to construct
     * the immutable S3 object key.
     *
     * Current schema:
     *
     * status = uploading
     * sha256 = NULL
     * uploadedAt = NULL
     */
    let artifact: Artifact;

    try {
      const [created] =
        await db
          .insert(artifacts)
          .values({
            runId:run.runId,
            name:
              normalizedName,

            kind,

            contentType:
              normalizedContentType,

            producerJobId:
              normalizedProducerJobId,

            producerJobAttemptId:
              normalizedProducerJobAttemptId,

            status:
              "uploading",

            sha256:
              null,

            s3BucketName:
              normalizedBucket,

            /**
             * Placeholder. We update it immediately below
             * after the generated artifact ID is known.
             */
            objectKey:
              `pending/${crypto.randomUUID()}`,

            sizeInBytes:
              sourceStats.size,

            expiresAt:
              expiresAt,

            uploadedAt:
              null,

            deletedAt:
              null,
          })
          .returning();

      if (!created) {
        throw new AppError(
          "Failed to create artifact record",
          500,
        );
      }

      artifact = created;
    } catch (error: unknown) {
      if (
        isUniqueViolation(
          error,
        )
      ) {
        throw new AppError(
          "An artifact with this name already exists for this run",
          409,
        );
      }

      throw error;
    }

    const objectKey =
      buildArtifactObjectKey({
        projectId:
          run.projectId,

        runId:
          run.runId,

        artifactId:
          artifact.id,

        name:
          normalizedName,
      });

    /**
     * Replace the temporary key before uploading.
     */
    const [keyUpdated] =
      await db
        .update(artifacts)
        .set({
          objectKey,
        })
        .where(
          and(
            eq(
              artifacts.id,
              artifact.id,
            ),
            eq(
              artifacts.status,
              "uploading",
            ),
          ),
        )
        .returning({
          id:
            artifacts.id,
        });

    if (!keyUpdated) {
      throw new AppError(
        "Failed to initialize artifact storage metadata",
        500,
      );
    }

    let s3UploadSucceeded =
      false;

    try {
      const upload =
        await uploadFileToS3({
          bucket:
            normalizedBucket,

          key:
            objectKey,

          filePath:
            localFilePath,

          contentType:
            normalizedContentType,
        });

      s3UploadSucceeded =
        true;

      /**
       * Protect the artifact row from another process racing
       * to move it out of `uploading`.
       */
      const [readyArtifact] =
        await db
          .update(artifacts)
          .set({
            status:
              "ready",

            sha256:
              upload.sha256,

            sizeInBytes:
              upload.sizeInBytes,

            uploadedAt:
              new Date(),
          })
          .where(
            and(
              eq(
                artifacts.id,
                artifact.id,
              ),
              eq(
                artifacts.status,
                "uploading",
              ),
            ),
          )
          .returning();

      if (!readyArtifact) {
        throw new AppError(
          "Artifact could not be marked ready",
          500,
        );
      }

      return readyArtifact;
    } catch (error: unknown) {
      /**
       * If S3 successfully contains the object but DB finalization
       * failed, remove the object.
       *
       * A process crash can still happen between these operations;
       * later reconciliation handles that case.
       */
      if (
        s3UploadSucceeded
      ) {
        try {
          await deleteObjectFromS3({
            bucket:
              normalizedBucket,

            key:
              objectKey,
          });
        } catch (
          cleanupError: unknown
        ) {
          console.error(
            "Failed to clean up artifact S3 object after DB failure",
            {
              artifactId:
                artifact.id,

              bucket:
                normalizedBucket,

              key:
                objectKey,

              cleanupError,
            },
          );
        }
      }

      /**
       * Preserve the failed artifact record for diagnosis/reconciliation.
       */
      try {
        await db
          .update(artifacts)
          .set({
            status:
              "failed",
          })
          .where(
            and(
              eq(
                artifacts.id,
                artifact.id,
              ),
              eq(
                artifacts.status,
                "uploading",
              ),
            ),
          );
      } catch (
        statusError: unknown
      ) {
        console.error(
          "Failed to mark artifact as failed",
          {
            artifactId:
              artifact.id,

            statusError,
          },
        );
      }

      throw error;
    }
  };

/* -------------------------------------------------------------------------- */
/* Get artifact                                                               */
/* -------------------------------------------------------------------------- */

export const getArtifactById =
  async (
    artifactId: string,
  ): Promise<Artifact> => {
    const normalizedArtifactId =
      normalizeUuid(
        artifactId,
        "artifactId",
      );

    const [artifact] =
      await db
        .select()
        .from(artifacts)
        .where(
          eq(
            artifacts.id,
            normalizedArtifactId,
          ),
        )
        .limit(1);

    if (!artifact) {
      throw new AppError(
        "Artifact not found",
        404,
      );
    }

    return artifact;
  };

/* -------------------------------------------------------------------------- */
/* List run artifacts                                                         */
/* -------------------------------------------------------------------------- */

export const listArtifactsForRun =
  async (
    runId: string,
  ): Promise<Artifact[]> => {
    const normalizedRunId =
      normalizeUuid(
        runId,
        "runId",
      );

    await getRunContext(
      normalizedRunId,
    );

    return db
      .select()
      .from(artifacts)
      .where(
        eq(
          artifacts.runId,
          normalizedRunId,
        ),
      )
      .orderBy(
        desc(
          artifacts.createdAt,
        ),
      );
  };

/* -------------------------------------------------------------------------- */
/* Download artifact                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Downloads a READY artifact and verifies:
 *
 * S3 bytes
 *       == DB sizeInBytes
 *
 * S3 SHA-256
 *       == DB sha256
 *
 * This catches corrupted/mismatched objects before deployment
 * consumes them.
 */
export const downloadArtifactToFile =
  async ({
    artifactId,
    destinationPath,
  }: {
    artifactId: string;
    destinationPath: string;
  }): Promise<{
    artifact: Artifact;
    sizeInBytes: number;
    sha256: string;
  }> => {
    const artifact =
      await getArtifactById(
        artifactId,
      );

    if (
      artifact.status !==
      "ready"
    ) {
      throw new AppError(
        `Artifact is not ready: ${artifact.status}`,
        409,
      );
    }

    if (
      artifact.expiresAt !==
        null &&
      artifact.expiresAt.getTime() <=
        Date.now()
    ) {
      throw new AppError(
        "Artifact has expired",
        410,
      );
    }

    if (
      artifact.sha256 ===
      null
    ) {
      throw new AppError(
        "Ready artifact has no SHA-256 digest",
        500,
      );
    }

    const download =
      await downloadFileFromS3({
        bucket:
          artifact.s3BucketName,

        key:
          artifact.objectKey,

        destinationPath,
      });

    /**
     * Verify durable metadata.
     */
    if (
      download.sizeInBytes !==
      artifact.sizeInBytes
    ) {
      await rm(
        destinationPath,
        {
          force: true,
        },
      );

      throw new AppError(
        "Artifact size does not match stored metadata",
        502,
      );
    }

    if (
      download.sha256 !==
      artifact.sha256
    ) {
      await rm(
        destinationPath,
        {
          force: true,
        },
      );

      throw new AppError(
        "Artifact checksum does not match stored metadata",
        502,
      );
    }

    return {
      artifact,
      sizeInBytes:
        download.sizeInBytes,
      sha256:
        download.sha256,
    };
  };

/* -------------------------------------------------------------------------- */
/* Frontend ZIP                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Creates:
 *
 * dist/
 *   ↓
 * temporary frontend-dist.zip
 *   ↓
 * one S3 upload
 *   ↓
 * one artifacts row
 */
export const createFrontendBuildArtifact =
  async ({
    runId,
    distDirectory,
    s3BucketName,
    producerJobId = null,
    producerJobAttemptId = null,
    artifactName =
      "frontend-dist.zip",
    expiresAt = null,
  }: {
    runId: string;
    distDirectory: string;
    s3BucketName: string;
    producerJobId?: string | null;
    producerJobAttemptId?:
      | string
      | null;
    artifactName?: string;
    expiresAt?: Date | null;
  }): Promise<Artifact> => {
    const normalizedRunId =
      normalizeUuid(
        runId,
        "runId",
      );

    const normalizedDistDirectory =
      distDirectory.trim();

    if (
      normalizedDistDirectory.length ===
      0
    ) {
      throw new AppError(
        "distDirectory cannot be empty",
        400,
      );
    }

    let directoryStats;

    try {
      directoryStats =
        await lstat(
          normalizedDistDirectory,
        );
    } catch {
      throw new AppError(
        "Frontend build directory does not exist",
        404,
      );
    }

    if (
      !directoryStats.isDirectory()
    ) {
      throw new AppError(
        "distDirectory must point to a directory",
        400,
      );
    }

    const temporaryDirectory =
      await mkdtemp(
        join(
          process.cwd(),
          ".deploybench-artifact-",
        ),
      );

    const zipPath =
      join(
        temporaryDirectory,
        "frontend-dist.zip",
      );

    try {
      const output =
        createWriteStream(
          zipPath,
        );

      const archive =
        new ZipArchive({
          zlib: {
            level: 9,
          },
        });

      archive.pipe(
        output,
      );

      /**
       * `false` means put the contents of dist/ at
       * the root of the ZIP rather than:
       *
       * dist/file.js
       *
       * resulting in:
       *
       * file.js
       */
      archive.directory(
        normalizedDistDirectory,
        false,
      );

      const outputFinished =
        finished(
          output,
        );

      /**
       * Current @archiver/archiver API resolves finalize()
       * when archive generation is complete.
       */
      await archive.finalize();

      await outputFinished;

      /**
       * One upload only.
       */
      return await createArtifactFromFile({
        runId:
          normalizedRunId,

        name:
          artifactName,

        kind:
          "archive",

        localFilePath:
          zipPath,

        s3BucketName:
          s3BucketName,

        contentType:
          "application/zip",

        producerJobId:
          producerJobId,

        producerJobAttemptId:
          producerJobAttemptId,

        expiresAt:
          expiresAt,
      });
    } finally {
      /**
       * The ZIP is only a temporary packaging file.
       *
       * The durable copy is the S3 object.
       */
      try {
        await rm(
          temporaryDirectory,
          {
            recursive: true,
            force: true,
          },
        );
      } catch (
        cleanupError: unknown
      ) {
        console.error(
          "Failed to clean temporary frontend artifact directory",
          {
            temporaryDirectory,
            cleanupError,
          },
        );
      }
    }
  };