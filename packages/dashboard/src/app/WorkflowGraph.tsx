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
import { useMemo } from 'react';
import type { RunStatus, StepCheckpoint, WorkflowRun } from '../client/durable-client';

const KIND_GLYPH: Record<string, string> = {
  local: '▢',
  remote: '◇',
  sleep: '◴',
  signal: '◈',
};

type StepData = {
  seq: number | string;
  name: string;
  kind: string;
  status: 'completed' | 'failed';
  workerGroup?: string;
  duration?: string;
};
type EndData = { status: RunStatus; label: string };

function StepCardNode({ data }: NodeProps<Node<StepData>>) {
  const failed = data.status === 'failed';
  return (
    <div
      className={`w-[190px] rounded-lg border bg-[var(--panel)]/95 px-3 py-2.5 shadow-lg backdrop-blur ${
        failed ? 'border-red-500/40' : 'border-[var(--line)]'
      }`}
    >
      <Handle type="target" position={Position.Left} className="!border-0 !bg-zinc-600" />
      <div className="flex items-center gap-2">
        <span
          className={`mono grid h-5 w-5 shrink-0 place-items-center rounded text-[10px] ${
            failed ? 'bg-red-500/15 text-red-300' : 'bg-emerald-500/15 text-emerald-300'
          }`}
        >
          {data.seq}
        </span>
        <span className="truncate text-[13px] font-medium text-zinc-100">{data.name}</span>
      </div>
      <div className="mono mt-1.5 flex items-center gap-2 text-[10px] text-zinc-500">
        <span className="rounded border border-[var(--line)] px-1 text-zinc-400">
          {KIND_GLYPH[data.kind] ?? '·'} {data.kind}
        </span>
        {data.workerGroup && <span>@{data.workerGroup}</span>}
        {data.duration && <span className="ml-auto">{data.duration}</span>}
      </div>
      <Handle type="source" position={Position.Right} className="!border-0 !bg-zinc-600" />
    </div>
  );
}

function TerminalNode({ data }: NodeProps<Node<EndData>>) {
  return (
    <div
      className={`s-${data.status} flex items-center gap-2 rounded-full border border-current/30 bg-[var(--panel)] px-3 py-1.5`}
    >
      <Handle type="target" position={Position.Left} className="!border-0 !bg-zinc-600" />
      <span className="dot" />
      <span className="mono text-[11px] uppercase tracking-wider">{data.label}</span>
      <Handle type="source" position={Position.Right} className="!border-0 !bg-zinc-600" />
    </div>
  );
}

const nodeTypes = { step: StepCardNode, terminal: TerminalNode };

export function WorkflowGraph({
  run,
  timeline,
  fmtDuration,
}: {
  run: WorkflowRun;
  timeline: StepCheckpoint[];
  fmtDuration: (a: string, b: string) => string;
}) {
  const { nodes, edges } = useMemo(() => {
    const gapX = 230;
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
        duration: fmtDuration(s.startedAt, s.finishedAt),
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
      edges.push({
        id: `e${i}`,
        source: from.id,
        target: node.id,
        animated: live && i === ordered.length - 1,
        style: { stroke: failed ? '#f87171' : 'var(--line)', strokeWidth: 1.5 },
      });
    }
    return { nodes: ordered, edges };
  }, [run, timeline, fmtDuration]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
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
