import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Ban,
  Box,
  CheckCircle2,
  Clock,
  FileArchive,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  RefreshCw,
  RotateCcw,
  Terminal,
  XCircle,
} from "lucide-react";

import {
  useCancelRun,
  useRetryRun,
  useRunDetails,
} from "@/hooks/useRuns";
import { useJobLogStream } from "@/hooks/useJobLogStream";
import { getApiErrorMessage } from "@/lib/api-error";
import type { JobStatus } from "@/types/job";

import { Button, buttonVariants } from "@/components/ui/button";

const renderJobStatusIcon = (status: JobStatus) => {
  switch (status) {
    case "success":
      return <CheckCircle2 className="size-4 text-emerald-500" />;
    case "running":
      return <Loader2 className="size-4 animate-spin text-blue-500" />;
    case "failed":
      return <XCircle className="size-4 text-destructive" />;
    case "queued":
    case "blocked":
      return <Clock className="size-4 text-amber-500" />;
    default:
      return <Ban className="size-4 text-muted-foreground" />;
  }
};

const RunDetailsPage = () => {
  const { projectId = "", runId = "" } = useParams<{
    projectId: string;
    runId: string;
  }>();
  const navigate = useNavigate();

  const {
    data,
    isPending,
    isError,
    error,
  } = useRunDetails(runId);

  const cancelMutation = useCancelRun(projectId);
  const retryMutation = useRetryRun(projectId);

  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  const jobs = data?.jobs ?? [];

  useEffect(() => {
    if (jobs.length === 0) {
      if (selectedJobId !== null) setSelectedJobId(null);
      return;
    }

    // The router can reuse this page when navigating between runs. If the
    // selected job belongs to the previous run, select a job from this run.
    if (!selectedJobId || !jobs.some((job) => job.id === selectedJobId)) {
      setSelectedJobId(jobs[0]!.id);
    }
  }, [jobs, selectedJobId]);

  const {
    logs,
    connectionState,
    errorMessage: sseError,
    reconnect,
    clearLogs,
  } = useJobLogStream({
    runId,
    jobId: selectedJobId,
    enabled: Boolean(runId && selectedJobId),
  });

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop =
        logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-8">
        <Link
          to={`/projects/${projectId}`}
          className={buttonVariants({ variant: "ghost" })}
        >
          <ArrowLeft className="size-4" />
          Back to project
        </Link>
        <div className="mt-6 rounded-xl border bg-background p-6">
          <p className="text-sm text-destructive">
            {getApiErrorMessage(error)}
          </p>
        </div>
      </main>
    );
  }

  const { run, attempts, artifacts, containerImages } = data;
  const selectedJob = jobs.find((j) => j.id === selectedJobId) ?? null;
  const selectedJobAttempts = attempts.filter(
    (a) => a.jobId === selectedJobId,
  );

  const isActive = run.status === "queued" || run.status === "running";

  const handleRetry = async () => {
    try {
      const response = await retryMutation.mutateAsync(run.id);
      navigate(`/projects/${projectId}/runs/${response.data.run.id}`);
    } catch {
      // Handled by toast
    }
  };

  return (
    <main className="min-h-screen bg-muted/30">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <Link
          to={`/projects/${projectId}`}
          className={buttonVariants({
            variant: "ghost",
            className: "-ml-3",
          })}
        >
          <ArrowLeft className="size-4" />
          Back to project
        </Link>

        {/* Run Header */}
        <div className="mt-4 flex flex-wrap items-start justify-between gap-4 rounded-xl border bg-background p-6">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-semibold tracking-tight">
                Run #{run.id.slice(0, 8)}
              </h1>
              <span className="rounded-md border px-2.5 py-0.5 text-xs font-medium capitalize">
                {run.status}
              </span>
              <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                Trigger: {run.trigger}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <GitBranch className="size-3.5" />
                {run.branch}
              </span>
              <span className="inline-flex items-center gap-1 font-mono">
                <GitCommitHorizontal className="size-3.5" />
                {run.commitSha}
              </span>
              <span>
                Created: {new Date(run.createdAt).toLocaleString()}
              </span>
            </div>

            {run.errorMessage && (
              <p className="text-xs text-destructive">
                {run.errorMessage}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            {isActive && (
              <Button
                variant="destructive"
                size="sm"
                disabled={cancelMutation.isPending}
                onClick={() => cancelMutation.mutate(run.id)}
              >
                <Ban className="size-4" />
                Cancel run
              </Button>
            )}

            <Button
              variant="outline"
              size="sm"
              disabled={retryMutation.isPending}
              onClick={handleRetry}
            >
              <RotateCcw className="size-4" />
              Retry run
            </Button>
          </div>
        </div>

        {/* Artifacts & Container Images */}
        {(artifacts.length > 0 || containerImages.length > 0) && (
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border bg-background p-4">
              <h2 className="flex items-center gap-2 text-sm font-medium">
                <FileArchive className="size-4 text-muted-foreground" />
                Build Artifacts ({artifacts.length})
              </h2>
              <div className="mt-3 space-y-2">
                {artifacts.map((art) => (
                  <div
                    key={art.id}
                    className="rounded border bg-muted/30 p-2.5 text-xs"
                  >
                    <p className="font-medium">{art.name}</p>
                    <p className="mt-0.5 font-mono text-muted-foreground">
                      ID: {art.id} · Status: {art.status}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl border bg-background p-4">
              <h2 className="flex items-center gap-2 text-sm font-medium">
                <Box className="size-4 text-muted-foreground" />
                Container Images ({containerImages.length})
              </h2>
              <div className="mt-3 space-y-2">
                {containerImages.map((img) => (
                  <div
                    key={img.id}
                    className="rounded border bg-muted/30 p-2.5 text-xs"
                  >
                    <p className="font-medium">
                      {img.repository}:{img.tag}
                    </p>
                    <p className="mt-0.5 font-mono text-muted-foreground">
                      ID: {img.id}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Jobs + Live SSE Log Stream */}
        <div className="mt-6 grid gap-6 lg:grid-cols-12">
          {/* Jobs Sidebar */}
          <div className="space-y-3 lg:col-span-4">
            <div className="rounded-xl border bg-background p-4">
              <h2 className="text-sm font-medium">
                Pipeline Jobs ({jobs.length})
              </h2>

              <div className="mt-3 space-y-2">
                {jobs.map((job) => {
                  const isSelected = job.id === selectedJobId;
                  return (
                    <button
                      key={job.id}
                      type="button"
                      onClick={() => setSelectedJobId(job.id)}
                      className={`flex w-full items-center justify-between rounded-lg border p-3 text-left text-sm transition-colors ${
                        isSelected
                          ? "border-primary bg-accent font-medium"
                          : "hover:bg-muted/50"
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {renderJobStatusIcon(job.status)}
                        <div className="truncate">
                          <p className="truncate">{job.name}</p>
                          <p className="font-mono text-xs text-muted-foreground">
                            {job.key}
                          </p>
                        </div>
                      </div>

                      <span className="text-xs capitalize text-muted-foreground">
                        {job.status}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {selectedJob && (
              <div className="rounded-xl border bg-background p-4 space-y-2 text-xs">
                <h3 className="text-sm font-medium">
                  Attempts ({selectedJobAttempts.length}/
                  {selectedJob.maxAttempts})
                </h3>
                {selectedJobAttempts.length === 0 ? (
                  <p className="text-muted-foreground">
                    No execution attempts started yet.
                  </p>
                ) : (
                  selectedJobAttempts.map((att) => (
                    <div
                      key={att.id}
                      className="rounded border bg-muted/30 p-2.5 space-y-1"
                    >
                      <div className="flex items-center justify-between font-medium">
                        <span>Attempt #{att.attemptNumber}</span>
                        <span className="capitalize">{att.status}</span>
                      </div>
                      {att.exitCode !== null && (
                        <p className="font-mono text-muted-foreground">
                          Exit code: {att.exitCode}
                        </p>
                      )}
                      {att.errorMessage && (
                        <p className="text-destructive">
                          {att.errorMessage}
                        </p>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* SSE Live Log Console */}
          <div className="lg:col-span-8">
            <div className="flex h-135 flex-col rounded-xl border bg-zinc-950 text-zinc-100 shadow-sm">
              <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <Terminal className="size-4 text-zinc-400" />
                  <span className="text-sm font-medium">
                    {selectedJob
                      ? `${selectedJob.name} (${selectedJob.key})`
                      : "Select a job"}
                  </span>
                  <span className="rounded bg-zinc-800 px-2 py-0.5 font-mono text-xs text-zinc-300">
                    SSE: {connectionState}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={clearLogs}
                  >
                    Clear
                  </Button>
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={reconnect}
                  >
                    <RefreshCw className="size-3" />
                    Reconnect
                  </Button>
                </div>
              </div>

              <div
                ref={logContainerRef}
                className="flex-1 overflow-y-auto p-4 font-mono text-xs leading-relaxed"
              >
                {sseError && (
                  <div className="mb-3 rounded border border-red-500/40 bg-red-950/40 px-3 py-2 text-red-300">
                    {sseError}
                  </div>
                )}

                {logs.length === 0 ? (
                  <p className="text-zinc-500">
                    {connectionState === "connecting"
                      ? "Connecting to Server-Sent Events log stream..."
                      : "Waiting for log output from job execution..."}
                  </p>
                ) : (
                  logs.map((entry, index) => (
                    <div
                      key={entry.id}
                      className="flex gap-3 py-0.5 hover:bg-zinc-900/60"
                    >
                      <span className="w-8 shrink-0 select-none text-right text-zinc-600">
                        {index + 1}
                      </span>
                      <span
                        className={`break-all whitespace-pre-wrap ${
                          entry.streamType === "stderr"
                            ? "text-red-400"
                            : entry.streamType === "system"
                              ? "text-amber-300"
                              : "text-zinc-200"
                        }`}
                      >
                        {entry.text}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
};

export default RunDetailsPage;


