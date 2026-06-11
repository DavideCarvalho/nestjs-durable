export type RunStatus = 'running' | 'suspended' | 'completed' | 'failed' | 'cancelled';
export type StepKind = 'local' | 'remote' | 'sleep' | 'signal';

export interface WorkflowRun {
  id: string;
  workflow: string;
  workflowVersion: string;
  status: RunStatus;
  input?: unknown;
  output?: unknown;
  error?: { message: string; code?: string };
  wakeAt?: number;
  createdAt: string;
  updatedAt: string;
}

export interface StepCheckpoint {
  runId: string;
  seq: number;
  name: string;
  kind: StepKind;
  status: 'completed' | 'failed';
  output?: unknown;
  error?: { message: string };
  attempts: number;
  workerGroup?: string;
  wakeAt?: number;
  startedAt: string;
  finishedAt: string;
}

export interface RunDetail {
  run: WorkflowRun;
  timeline: StepCheckpoint[];
}

declare global {
  interface Window {
    /** Mount base (e.g. `/ops/durable`) injected by the UI controller; falls back to `/durable`. */
    __DURABLE_BASE__?: string;
  }
}

function apiBase(): string {
  const base = (typeof window !== 'undefined' && window.__DURABLE_BASE__) || '/durable';
  return `${base}/api`;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiBase() + path, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export const durableClient = {
  runs(status?: RunStatus): Promise<WorkflowRun[]> {
    return http<WorkflowRun[]>(status ? `/runs?status=${status}` : '/runs');
  },
  run(id: string): Promise<RunDetail> {
    return http<RunDetail>(`/runs/${encodeURIComponent(id)}`);
  },
  retry(id: string): Promise<WorkflowRun> {
    return http<WorkflowRun>(`/runs/${encodeURIComponent(id)}/retry`, { method: 'POST' });
  },
  cancel(id: string): Promise<WorkflowRun> {
    return http<WorkflowRun>(`/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  },
};
