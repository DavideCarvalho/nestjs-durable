import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react';
import { useCallback, useMemo } from 'react';
import type { RunStatus, StepCheckpoint, WorkflowRun } from '../client/durable-client';
import { BoltIcon, CheckIcon, iconFor, KIND_LABEL, XIcon } from './icons';

type SubCounts = { ok: number; failed: number; skipped: number };
type StepData = {
  seq: number;
  name: string;
  kind: string;
  status: 'pending' | 'completed' | 'failed';
  workerGroup?: string;
  attempts: number;
  duration?: string;
  subs?: SubCounts;
  selected: boolean;
};
type EndData = { status: RunStatus; label: string };

function StepCardNode({ data }: NodeProps<Node<StepData>>) {
  const failed = data.status === 'failed';
  const pending = data.status === 'pending'; // dispatched, awaiting its worker result (in-flight)
  const Icon = iconFor(data.kind);
  // Literal class strings per state (Tailwind can't see interpolated names): failed → red,
  // in-flight → amber, done → emerald.
  const tone = failed
    ? {
        rail: 'bg-red-400',
        badge: 'bg-red-500/15 text-red-300',
        pill: 'bg-red-500/20 text-red-300',
      }
    : pending
      ? {
          rail: 'bg-amber-400',
          badge: 'bg-amber-500/15 text-amber-300',
          pill: 'bg-amber-500/20 text-amber-300',
        }
      : {
          rail: 'bg-emerald-400',
          badge: 'bg-emerald-500/15 text-emerald-300',
          pill: 'bg-emerald-500/20 text-emerald-300',
        };
  return (
    <div
      title={KIND_LABEL[data.kind] ?? data.kind}
      className={`group relative w-[208px] cursor-pointer overflow-hidden rounded-xl border bg-[var(--panel)]/95 shadow-lg backdrop-blur transition-all duration-150 hover:-translate-y-0.5 ${
        data.selected
          ? 'border-emerald-400/60 ring-2 ring-emerald-400/30'
          : failed
            ? 'border-red-500/40 hover:border-red-400/60'
            : 'border-[var(--line)] hover:border-zinc-600'
      }`}
    >
      {/* status rail */}
      <span
        className={`absolute inset-y-0 left-0 w-[3px] ${tone.rail} ${pending ? 'animate-pulse' : ''}`}
      />
      <Handle type="target" position={Position.Left} className="!border-0 !bg-zinc-600" />
      <div className="py-2.5 pl-3.5 pr-3">
        <div className="flex items-center gap-2">
          <span className={`grid h-5 w-5 shrink-0 place-items-center rounded ${tone.badge}`}>
            <Icon width={12} height={12} />
          </span>
          <span className="truncate text-[13px] font-medium text-zinc-100">{data.name}</span>
          <span
            className={`ml-auto grid h-4 w-4 shrink-0 place-items-center rounded-full ${tone.pill} ${pending ? 'animate-pulse' : ''}`}
          >
            {failed ? (
              <XIcon width={9} height={9} />
            ) : pending ? (
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
            ) : (
              <CheckIcon width={9} height={9} />
            )}
          </span>
        </div>
        <div className="mono mt-1.5 flex items-center gap-1.5 text-[10px] text-zinc-500">
          <span className="rounded border border-[var(--line)] px-1 text-zinc-400">
            {data.kind}
          </span>
          {data.attempts > 1 && (
            <span className="flex items-center gap-0.5 text-amber-300">
              <BoltIcon width={9} height={9} />
              {data.attempts}
            </span>
          )}
          {data.workerGroup && <span className="truncate">@{data.workerGroup}</span>}
          <span className="tnum ml-auto text-zinc-400">
            #{data.seq}
            {data.duration && <span className="text-zinc-600"> · {data.duration}</span>}
          </span>
        </div>
        {data.subs && (
          <div className="mono mt-1.5 flex items-center gap-2 border-t border-[var(--line)] pt-1.5 text-[10px]">
            {data.subs.ok > 0 && <span className="text-emerald-300">{data.subs.ok} ok</span>}
            {data.subs.failed > 0 && (
              <span className="text-red-300">{data.subs.failed} failed</span>
            )}
            {data.subs.skipped > 0 && (
              <span className="text-amber-300">{data.subs.skipped} skipped</span>
            )}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="!border-0 !bg-zinc-600" />
    </div>
  );
}

function TerminalNode({ data }: NodeProps<Node<EndData>>) {
  const live = data.status === 'running' || data.status === 'suspended';
  return (
    <div
      className={`s-${data.status} flex items-center gap-2 rounded-full border border-current/30 bg-[var(--panel)] px-3.5 py-1.5`}
    >
      <Handle type="target" position={Position.Left} className="!border-0 !bg-zinc-600" />
      <span className={`dot ${live ? 'pulse' : ''}`} />
      <span className="mono text-[11px] uppercase tracking-wider">{data.label}</span>
      <Handle type="source" position={Position.Right} className="!border-0 !bg-zinc-600" />
    </div>
  );
}

const nodeTypes = { step: StepCardNode, terminal: TerminalNode };

/** Tally a step's sub-process outcomes (e.g. parallel p-processes) for the at-a-glance node badge.
 *  Returns undefined when the step emitted no sub-process events. */
function subCounts(s: StepCheckpoint): SubCounts | undefined {
  const subs = s.events?.filter((e) => e.status);
  if (!subs || subs.length === 0) return undefined;
  return {
    ok: subs.filter((e) => e.status === 'ok').length,
    failed: subs.filter((e) => e.status === 'failed').length,
    skipped: subs.filter((e) => e.status === 'skipped').length,
  };
}

export function WorkflowGraph({
  run,
  timeline,
  selected,
  onSelect,
  fmtDuration,
}: {
  run: WorkflowRun;
  timeline: StepCheckpoint[];
  selected?: number;
  onSelect: (seq: number) => void;
  fmtDuration: (a: string, b: string) => string;
}) {
  const { nodes, edges } = useMemo(() => {
    const gapX = 248;
    const y = 0;
    const startNode: Node = {
      id: 'start',
      type: 'terminal',
      position: { x: 0, y },
      data: { status: 'running', label: run.workflow } satisfies EndData,
      draggable: false,
    };
    const stepNodes: Node[] = timeline.map((s, i) => ({
      id: `s${s.seq}`,
      type: 'step',
      position: { x: (i + 1) * gapX, y },
      draggable: false,
      data: {
        seq: s.seq,
        name: s.name,
        kind: s.kind,
        status: s.status,
        workerGroup: s.workerGroup,
        attempts: s.attempts,
        duration: fmtDuration(s.startedAt, s.finishedAt),
        subs: subCounts(s),
        selected: selected === s.seq,
      } satisfies StepData,
    }));
    const endNode: Node = {
      id: 'end',
      type: 'terminal',
      position: { x: (timeline.length + 1) * gapX, y },
      draggable: false,
      data: { status: run.status, label: run.status } satisfies EndData,
    };

    const ordered = [startNode, ...stepNodes, endNode];
    const live = run.status === 'running' || run.status === 'suspended';
    const edges: Edge[] = [];
    for (let i = 1; i < ordered.length; i += 1) {
      const from = ordered[i - 1];
      const node = ordered[i];
      if (!from || !node) continue;
      const failed = node.type === 'step' && (node.data as StepData).status === 'failed';
      const lastLive = live && i === ordered.length - 1;
      edges.push({
        id: `e${i}`,
        source: from.id,
        target: node.id,
        animated: lastLive,
        style: {
          stroke: failed ? '#f87171' : lastLive ? 'var(--accent)' : 'var(--line)',
          strokeWidth: lastLive ? 2 : 1.5,
        },
      });
    }
    return { nodes: ordered, edges };
  }, [run, timeline, fmtDuration, selected]);

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      if (node.type === 'step') onSelect((node.data as StepData).seq);
    },
    [onSelect],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={onNodeClick}
      fitView
      fitViewOptions={{ padding: 0.3, maxZoom: 1.1 }}
      proOptions={{ hideAttribution: true }}
      nodesConnectable={false}
      nodesDraggable={false}
      panOnScroll
      minZoom={0.3}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#1c1c22" />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  );
}
