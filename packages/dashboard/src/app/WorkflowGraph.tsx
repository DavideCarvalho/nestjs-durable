import { useQueries } from '@tanstack/react-query';
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
import {
  type RunDetail,
  type RunDisplayStatus,
  type StepCheckpoint,
  type WorkflowRun,
  durableClient,
  runDisplayStatus,
} from '../client/durable-client';
import { childRunIdOf } from './child-link';
import { BoltIcon, CheckIcon, ChildIcon, KIND_LABEL, XIcon, iconFor } from './icons';

/** Stable empty set so a graph with no `expanded` prop doesn't re-run the layout memo each render. */
const EMPTY_EXPANDED: Set<string> = new Set();

/** Awaited child (`ctx.child`, `signal:child:<id>`) returns to the parent; fire-and-forget
 *  (`ctx.startChild`, `spawn:<id>`) does not. Drives whether an expanded child rejoins the flow. */
function isAwaitedChild(name: string): boolean {
  return name.startsWith('signal:child:');
}

/**
 * Fetch the RunDetail of every expanded child, keyed by run id, so the layout can weave each child's
 * flow in as a lane. We fetch exactly the ids in `expanded` (no reachability walk needed: a child is
 * only toggle-able once its node is visible, i.e. its ancestors are already expanded). The returned
 * map is stable across renders unless the expansion set or a query's loaded state changes — so the
 * downstream layout memo doesn't recompute on every render.
 */
function useExpandedChildDetails(expanded: Set<string>): Record<string, RunDetail> {
  const ids = useMemo(() => [...expanded].sort(), [expanded]);
  const results = useQueries({
    queries: ids.map((id) => ({ queryKey: ['run', id], queryFn: () => durableClient.run(id) })),
  });
  // Plain (non-memoized) projection of the settled queries — cheap, and avoids depending on the
  // useQueries result array (new identity each render) inside a memo. The layout below is likewise
  // recomputed each render (graph is small; ReactFlow diffs nodes/edges by id).
  const map: Record<string, RunDetail> = {};
  ids.forEach((id, i) => {
    const detail = results[i]?.data;
    if (detail) map[id] = detail;
  });
  return map;
}

type SubCounts = { ok: number; failed: number; skipped: number };
type StepData = {
  seq: number;
  name: string;
  kind: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  workerGroup?: string;
  attempts: number;
  duration?: string;
  subs?: SubCounts;
  selected: boolean;
  /** When this step ran a child workflow, the child's run id. Clicking the node opens its detail
   *  like any other step; only the `child ↗` badge navigates to the child run. */
  childRunId?: string;
  /** Navigate to the child run — invoked only by the `child ↗` badge, not a node-body click. */
  onOpenRun?: (id: string) => void;
  /** Whether this child node's sub-flow is currently expanded inline (drives the chevron). */
  childExpanded?: boolean;
  /** Toggle inline expansion of this child node's sub-flow in the graph. */
  onToggleChild?: (id: string) => void;
  /** Lane depth: 0 = root run, 1 = a child's flow, 2 = a grandchild's, … (tints nested nodes). */
  depth?: number;
};
type EndData = { status: RunDisplayStatus; label: string };

function StepCardNode({ data }: NodeProps<Node<StepData>>) {
  const failed = data.status === 'failed';
  // in-flight: a remote step awaiting its worker (`pending`) or a local step body executing (`running`)
  const pending = data.status === 'pending' || data.status === 'running';
  const isChild = !!data.childRunId;
  const Icon = isChild ? ChildIcon : iconFor(data.kind);
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
      title={isChild ? KIND_LABEL.child : (KIND_LABEL[data.kind] ?? data.kind)}
      className={`group relative w-[208px] cursor-pointer overflow-hidden rounded-xl border bg-[var(--panel)]/95 shadow-lg backdrop-blur transition-all duration-150 hover:-translate-y-0.5 ${
        data.selected
          ? 'border-emerald-400/60 ring-2 ring-emerald-400/30'
          : failed
            ? 'border-red-500/40 hover:border-red-400/60'
            : isChild
              ? 'border-indigo-500/40 hover:border-indigo-400/60'
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
          {isChild ? (
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={(e) => {
                  // Expand/collapse the child's flow inline as a lane below; don't open the detail.
                  e.stopPropagation();
                  if (data.childRunId) data.onToggleChild?.(data.childRunId);
                }}
                title={data.childExpanded ? 'Collapse child flow' : 'Expand child flow inline'}
                className="grid h-4 w-4 place-items-center rounded border border-indigo-500/30 bg-indigo-500/10 text-indigo-300 transition-colors hover:border-indigo-400/60 hover:bg-indigo-500/20 hover:text-indigo-200"
              >
                <span
                  className="inline-block text-[9px] transition-transform"
                  style={{ transform: data.childExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
                >
                  ▸
                </span>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  // Dedicated "go to the child run" affordance (the node-body click opens the detail).
                  e.stopPropagation();
                  if (data.childRunId) data.onOpenRun?.(data.childRunId);
                }}
                title="Open the child run"
                className="rounded border border-indigo-500/30 bg-indigo-500/10 px-1 text-indigo-300 transition-colors hover:border-indigo-400/60 hover:bg-indigo-500/20 hover:text-indigo-200"
              >
                child ↗
              </button>
            </span>
          ) : (
            <span className="rounded border border-[var(--line)] px-1 text-zinc-400">
              {data.kind}
            </span>
          )}
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
  // Open (non-terminal) states pulse. `suspended` no longer reaches here — runDisplayStatus refines
  // it to running / awaiting (both open → pulse) or sleeping (parked on a timer → static).
  const live = data.status === 'running' || data.status === 'awaiting';
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
  onOpenRun,
  fmtDuration,
  expanded,
  onToggleChild,
}: {
  run: WorkflowRun;
  timeline: StepCheckpoint[];
  selected?: number;
  onSelect: (seq: number) => void;
  /** Navigate to another run — used by a child-workflow node's `child ↗` badge. */
  onOpenRun: (id: string) => void;
  fmtDuration: (a: string, b: string) => string;
  /** Child run ids whose sub-flow is expanded inline in the graph. */
  expanded?: Set<string>;
  /** Toggle inline expansion of a child node's sub-flow. */
  onToggleChild?: (id: string) => void;
}) {
  const resolvedExpanded = expanded ?? EMPTY_EXPANDED;
  const childData = useExpandedChildDetails(resolvedExpanded);

  // Built inline (not memoized): it reads `childData`, a fresh object each render, and the graph is
  // small enough that recomputing is cheap; ReactFlow reconciles nodes/edges by id.
  const { nodes, edges } = (() => {
    const gapX = 248;
    const laneY = 150;
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const live = run.status === 'running' || run.status === 'suspended';
    const mainEdge = (source: string, target: string, failed: boolean): Edge => ({
      id: `${source}->${target}`,
      source,
      target,
      style: { stroke: failed ? '#f87171' : 'var(--line)', strokeWidth: 1.5 },
    });
    // The branch from a child node down into its expanded sub-flow's first step — dashed + indigo so
    // it reads as "drills into a sub-workflow", distinct from the solid main-flow edges.
    const branchEdge = (source: string, target: string): Edge => ({
      id: `${source}=>${target}`,
      source,
      target,
      style: { stroke: '#818cf8', strokeWidth: 1.5, strokeDasharray: '4 3' },
    });

    // Lay out a run's timeline on lane `depth`, starting at `startX`. Returns the flow's first node
    // id, its exit connector (the node the next main step links from — a child's exit when an awaited
    // child rejoined), and the x just past the flow, so the caller can place/rejoin after it.
    function layout(
      tl: StepCheckpoint[],
      depth: number,
      startX: number,
      prefix: string,
    ): { firstId?: string; connectorId?: string; nextX: number } {
      let cursorX = startX;
      let firstId: string | undefined;
      let connectorId: string | undefined;
      let prevFailed = false;
      for (const s of tl) {
        const id = `${prefix}s${s.seq}`;
        const childId = childRunIdOf(s);
        const childExpanded = childId !== undefined && resolvedExpanded.has(childId);
        nodes.push({
          id,
          type: 'step',
          draggable: false,
          position: { x: cursorX, y: depth * laneY },
          data: {
            seq: s.seq,
            name: s.name,
            kind: s.kind,
            status: s.status,
            workerGroup: s.workerGroup,
            attempts: s.attempts,
            duration: fmtDuration(s.startedAt, s.finishedAt),
            subs: subCounts(s),
            selected: depth === 0 && selected === s.seq,
            childRunId: childId,
            onOpenRun,
            childExpanded,
            onToggleChild,
            depth,
          } satisfies StepData,
        });
        if (firstId === undefined) firstId = id;
        if (connectorId !== undefined) edges.push(mainEdge(connectorId, id, prevFailed));

        const detail = childId !== undefined && childExpanded ? childData[childId] : undefined;
        if (detail) {
          const sub = layout(detail.timeline, depth + 1, cursorX + gapX, `${childId}:`);
          if (sub.firstId !== undefined) edges.push(branchEdge(id, sub.firstId));
          if (isAwaitedChild(s.name) && sub.connectorId !== undefined) {
            // Awaited: the parent flow passes through the child and resumes after it.
            connectorId = sub.connectorId;
          } else {
            // Fire-and-forget: the child runs in parallel below; the parent continues from here.
            connectorId = id;
          }
          cursorX = Math.max(cursorX + gapX, sub.nextX);
        } else {
          connectorId = id;
          cursorX += gapX;
        }
        prevFailed = s.status === 'failed';
      }
      return { firstId, connectorId, nextX: cursorX };
    }

    const gap0 = 248;
    nodes.push({
      id: 'start',
      type: 'terminal',
      position: { x: 0, y: 0 },
      draggable: false,
      data: { status: 'running', label: run.workflow } satisfies EndData,
    });
    const root = layout(timeline, 0, gap0, '');
    if (root.firstId !== undefined) {
      edges.push({ id: 'start->first', source: 'start', target: root.firstId });
    }
    const shown = runDisplayStatus(run, timeline);
    nodes.push({
      id: 'end',
      type: 'terminal',
      position: { x: Math.max(root.nextX, gap0), y: 0 },
      draggable: false,
      data: { status: shown, label: shown } satisfies EndData,
    });
    edges.push({
      id: 'exit->end',
      source: root.connectorId ?? 'start',
      target: 'end',
      animated: live,
      style: { stroke: live ? 'var(--accent)' : 'var(--line)', strokeWidth: live ? 2 : 1.5 },
    });

    return { nodes, edges };
  })();

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      if (node.type !== 'step') return;
      const data = node.data as StepData;
      // Only root-lane steps open the detail panel (it's keyed by the root run's seq). A nested
      // child step's detail lives in its own run — reach it via the child's `↗` badge. Every step's
      // own expand chevron still works at any depth (it's a node-data callback, not this handler).
      if (data.depth && data.depth > 0) return;
      onSelect(data.seq);
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
