import {
  publishNextOutboxMessage,
} from "../services/outbox/outbox.service.js";

const POLL_INTERVAL_MS = 1_000;

const sleep = (
  milliseconds: number,
): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

let stopRequested = false;

export const stopOutboxWorker =
  (): void => {
    stopRequested = true;
  };

export const startOutboxWorker =
  async (): Promise<void> => {
    stopRequested = false;

    while (!stopRequested) {
      try {
        const didPublish =
          await publishNextOutboxMessage();

        if (!didPublish) {
          await sleep(
            POLL_INTERVAL_MS,
          );
        }
      } catch (error) {
        console.error(
          "Outbox worker error:",
          error,
        );

        await sleep(
          POLL_INTERVAL_MS,
        );
      }
    }
  };