import { useCallback, useEffect, useRef, useState } from "react";
import { getJobLogStreamUrl } from "@/api/jobApi";
import type { LogLineEntry } from "@/types/job";

export type StreamConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "completed"
  | "error";

interface UseJobLogStreamOptions {
  runId: string;
  jobId: string | null;
  enabled?: boolean;
}

export const useJobLogStream = ({
  runId,
  jobId,
  enabled = true,
}: UseJobLogStreamOptions) => {
  const [logs, setLogs] = useState<LogLineEntry[]>([]);
  const [connectionState, setConnectionState] =
    useState<StreamConnectionState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const counterRef = useRef(0);

  const appendPayload = useCallback((rawData: string, fallbackType?: string) => {
    try {
      const parsed = JSON.parse(rawData) as Record<string, unknown>;

      // Handle array of lines or chunks
      if (Array.isArray(parsed.lines)) {
        const streamType =
          parsed.streamType === "stderr" || parsed.streamType === "system"
            ? parsed.streamType
            : "stdout";
        const timestamp =
          typeof parsed.timestamp === "string"
            ? parsed.timestamp
            : new Date().toISOString();

        const entries: LogLineEntry[] = parsed.lines.map((line) => ({
          id: `log-${++counterRef.current}`,
          streamType,
          timestamp,
          text: String(line),
        }));
        setLogs((prev) => [...prev, ...entries]);
        return;
      }

      const content =
        typeof parsed.chunk === "string"
          ? parsed.chunk
          : typeof parsed.line === "string"
            ? parsed.line
            : typeof parsed.message === "string"
              ? parsed.message
              : typeof parsed.text === "string"
                ? parsed.text
                : typeof parsed.data === "string"
                  ? parsed.data
                  : null;

      if (content !== null) {
        const streamType =
          parsed.streamType === "stderr" ||
          parsed.stream === "stderr" ||
          fallbackType === "stderr"
            ? "stderr"
            : parsed.streamType === "system" ||
                parsed.stream === "system" ||
                fallbackType === "system"
              ? "system"
              : "stdout";

        const timestamp =
          typeof parsed.timestamp === "string"
            ? parsed.timestamp
            : new Date().toISOString();

        const lines = content.replace(/\r\n/g, "\n").split("\n");
        if (lines[lines.length - 1] === "") {
          lines.pop();
        }

        const newEntries: LogLineEntry[] = lines.map((lineText) => ({
          id: `log-${++counterRef.current}`,
          streamType,
          timestamp,
          text: lineText,
          ...(typeof parsed.sequence === "number"
            ? { sequence: parsed.sequence }
            : {}),
        }));

        setLogs((prev) => [...prev, ...newEntries]);
      }
    } catch {
      // Plain text SSE data fallback
      if (rawData.trim().length > 0) {
        setLogs((prev) => [
          ...prev,
          {
            id: `log-${++counterRef.current}`,
            streamType: "stdout",
            timestamp: new Date().toISOString(),
            text: rawData,
          },
        ]);
      }
    }
  }, []);

  const connect = useCallback(() => {
    if (!runId || !jobId || !enabled) {
      return;
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    setLogs([]);
    setErrorMessage(null);
    setConnectionState("connecting");

    const streamUrl = getJobLogStreamUrl(runId, jobId);
    const es = new EventSource(streamUrl, { withCredentials: true });
    eventSourceRef.current = es;

    es.onopen = () => {
      setConnectionState("connected");
    };

    es.onmessage = (event: MessageEvent<string>) => {
      appendPayload(event.data);
    };

    const logEvents = ["log", "chunk", "line", "stdout", "stderr", "system", "history"];
    for (const evtName of logEvents) {
      es.addEventListener(evtName, (event) => {
        const msgEvent = event as MessageEvent<string>;
        appendPayload(msgEvent.data, evtName);
      });
    }

    const endEvents = ["end", "complete", "completed", "done", "stream-end", "close"];
    for (const evtName of endEvents) {
      es.addEventListener(evtName, () => {
        setConnectionState("completed");
        es.close();
      });
    }

    es.addEventListener("error", (event) => {
      const msgEvent = event as MessageEvent<string>;
      if (typeof msgEvent.data === "string" && msgEvent.data.length > 0) {
        try {
          const parsed = JSON.parse(msgEvent.data) as { message?: string };
          if (parsed.message) {
            setErrorMessage(parsed.message);
          }
        } catch {
          setErrorMessage(msgEvent.data);
        }
      }
    });

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        setConnectionState((prev) =>
          prev === "completed" ? "completed" : "idle",
        );
      } else {
        setConnectionState("error");
        es.close();
      }
    };
  }, [appendPayload, enabled, jobId, runId]);

  useEffect(() => {
    connect();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [connect]);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  return {
    logs,
    connectionState,
    errorMessage,
    reconnect: connect,
    clearLogs,
  };
};