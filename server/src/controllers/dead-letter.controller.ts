import type {
  NextFunction,
  Request,
  Response,
} from "express";

import { AppError } from "../utils/app.error.js";
import {
  getDeadLetter,
  listDeadLetters,
  replayDeadLetter,
  resolveReplayedDeadLetter,
  type DeadLetterStatus,
} from "../services/dead-letters/dead-letter.service.js";

/* -------------------------------------------------------------------------- */
/* Query parsing                                                              */
/* -------------------------------------------------------------------------- */

const parseStatusValue = (status: string): DeadLetterStatus => {
  switch (status) {
    case "open":
    case "replayed":
    case "resolved":
    case "discarded":
      return status;
    default:
      throw new AppError("Invalid dead-letter status", 400);
  }
};

const getSingleQueryValue = (
  value: unknown,
  field: string,
): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new AppError(`Invalid ${field}`, 400);
  }

  return value;
};

const parseStatus = (
  value: unknown,
): DeadLetterStatus | undefined => {
  const status = getSingleQueryValue(value, "status");

  if (status === undefined) {
    return undefined;
  }

  return parseStatusValue(status);
};

const parseQueueName = (value: unknown): string | undefined => {
  const queueName = getSingleQueryValue(value, "queueName");

  if (queueName === undefined) {
    return undefined;
  }

  const normalized = queueName.trim();

  if (normalized.length === 0 || normalized.length > 120) {
    throw new AppError("Invalid dead-letter queue name", 400);
  }

  return normalized;
};

const parseLimit = (value: unknown): number | undefined => {
  const rawLimit = getSingleQueryValue(value, "limit");

  if (rawLimit === undefined) {
    return undefined;
  }

  if (!/^[0-9]+$/.test(rawLimit)) {
    throw new AppError("Dead-letter limit must be a positive integer", 400);
  }

  const limit = Number(rawLimit);

  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AppError("Dead-letter limit must be between 1 and 100", 400);
  }

  return limit;
};

/* -------------------------------------------------------------------------- */
/* Controllers                                                                */
/* -------------------------------------------------------------------------- */

export const listDeadLetterRecords = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const status = parseStatus(req.query.status);
    const queueName = parseQueueName(req.query.queueName);
    const limit = parseLimit(req.query.limit);

    const deadLetters = await listDeadLetters({
      ...(status === undefined ? {} : { status }),
      ...(queueName === undefined ? {} : { queueName }),
      ...(limit === undefined ? {} : { limit }),
    });

    res.status(200).json({
      success: true,
      message: "dead letters fetched",
      data: {
        deadLetters,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getDeadLetterRecord = async (
  req: Request<{ deadLetterId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const deadLetter = await getDeadLetter(req.params.deadLetterId);

    res.status(200).json({
      success: true,
      message: "dead letter fetched",
      data: {
        deadLetter,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const replayDeadLetterRecord = async (
  req: Request<{ deadLetterId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const result = await replayDeadLetter(req.params.deadLetterId);

    res.status(202).json({
      success: true,
      message: "dead letter replay queued",
      data: {
        deadLetter: result.deadLetter,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const resolveDeadLetterRecord = async (
  req: Request<{ deadLetterId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const deadLetter = await resolveReplayedDeadLetter(
      req.params.deadLetterId,
    );

    res.status(200).json({
      success: true,
      message: "dead letter resolved",
      data: {
        deadLetter,
      },
    });
  } catch (error) {
    next(error);
  }
};
