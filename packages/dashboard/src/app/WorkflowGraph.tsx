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
import { groupParallelSpans } from '../client/group-parallel-spans';
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
  workerGroup?: string | undefined;
  attempts: number;
  duration?: string | undefined;
  subs?: SubCounts | undefined;
  selected: boolean;
  /** When this step ran a child workflow, the child's run id. Clicking the node opens its detail
   *  like any other step; only the `child ↗` badge navigates to the child run. */
  childRunId?: string | undefined;
  /** Navigate to the child run — invoked only by the `child ↗` badge, not a node-body click. */
  onOpenRun?: ((id: string) => void) | undefined;
  /** Whether this child node's sub-flow is currently expanded inline (drives the chevron). */
  childExpanded?: boolean | undefined;
  /** Toggle inline expansion of this child node's sub-flow in the graph. */
  onToggleChild?: ((id: string) => void) | undefined;
  /** Lane depth: 0 = root run, 1 = a child's flow, 2 = a grandchild's, … (tints nested nodes). */
  depth?: number | undefined;
  /** The underlying checkpoint + the run it belongs to (its own lane's run), so a node-body click
   *  can open the right detail even for a nested child step. */
  step?: StepCheckpoint;
  laneRun?: WorkflowRun;
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
  selectedKey,
  onSelect,
  onOpenRun,
  fmtDuration,
  expanded,
  onToggleChild,
}: {
  run: WorkflowRun;
  timeline: StepCheckpoint[];
  /** `${runId}#${seq}` of the selected step (a nested child step lives in its own run). */
  selectedKey?: string | undefined;
  /** Open a step's detail — the step + the run it belongs to (root or a nested child run). */
  onSelect: (step: StepCheckpoint, run: WorkflowRun) => void;
  /** Navigate to another run — used by a child-workflow node's `child ↗` badge. */
  onOpenRun: (id: string) => void;
  fmtDuration: (a: string, b: string) => string;
  /** Child run ids whose sub-flow is expanded inline in the graph. */
  expanded?: Set<string> | undefined;
  /** Toggle inline expansion of a child node's sub-flow. */
  onToggleChild?: ((id: string) => void) | undefined;
}) {
  const resolvedExpanded = expanded ?? EMPTY_EXPANDED;
  // Fetch every expanded child (to lay out its sub-flow) plus every root-level child (so even a
  // collapsed child node reads the child's real workflow name, not the raw `signal:child:<id>`).
  const childIdsToFetch = useMemo(() => {
    const ids = new Set(resolvedExpanded);
    for (const step of timeline) {
      const childId = childRunIdOf(step);
      if (childId !== undefined) ids.add(childId);
    }
    return ids;
  }, [resolvedExpanded, timeline]);
  const childData = useExpandedChildDetails(childIdsToFetch);

  // Built inline (not memoized): it reads `childData`, a fresh object each render, and the graph is
  // small enough that recomputing is cheap; ReactFlow reconciles nodes/edges by id.
  const { nodes, edges } = (() => {
    const gapX = 248;
    const laneY = 150;
    // Vertical pitch between members of a parallel fan stacked in one column (card height + breathing
    // room). Parallel siblings sit at the same x, one below the other — they ran concurrently.
    const FAN_ROW = 96;
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

    // A connector is a node the *next* step links from, plus whether its source failed (so the edge
    // tints red). A sequential step exposes one; a parallel fan exposes one per member (fan-in).
    type FlowConnector = { id: string; failed: boolean };

    // Place one step node at (x, y). When its child is expanded, lay that child's sub-flow out as
    // lanes below/right (recursing into `layout`). Returns the node id, the connector(s) the next
    // step links from (this node, or — for an awaited child — the child flow's exits), and the x/y
    // extents the node (plus any expanded sub-flow) consumed, so the caller can place what follows.
    function placeStep(
      s: StepCheckpoint,
      x: number,
      y: number,
      depth: number,
      prefix: string,
      laneRun: WorkflowRun,
    ): { id: string; exits: FlowConnector[]; nextX: number; bottomY: number } {
      const id = `${prefix}s${s.seq}`;
      const childId = childRunIdOf(s);
      const childExpanded = childId !== undefined && resolvedExpanded.has(childId);
      // Child nodes read the child's real workflow name, not the raw `signal:child:<id>` checkpoint.
      const displayName =
        childId !== undefined ? (childData[childId]?.run.workflow ?? 'child workflow') : s.name;
      const failed = s.status === 'failed';
      nodes.push({
        id,
        type: 'step',
        draggable: false,
        position: { x, y },
        data: {
          seq: s.seq,
          name: displayName,
          kind: s.kind,
          status: s.status,
          workerGroup: s.workerGroup,
          attempts: s.attempts,
          duration: fmtDuration(s.startedAt, s.finishedAt),
          subs: subCounts(s),
          selected: selectedKey === `${s.runId}#${s.seq}`,
          childRunId: childId,
          onOpenRun,
          childExpanded,
          onToggleChild,
          depth,
          step: s,
          laneRun,
        } satisfies StepData,
      });

      const detail = childId !== undefined && childExpanded ? childData[childId] : undefined;
      if (detail) {
        const sub = layout(
          detail.timeline,
          depth + 1,
          x + gapX,
          y + laneY,
          `${childId}:`,
          detail.run,
        );
        for (const firstId of sub.firstIds) edges.push(branchEdge(id, firstId));
        // Awaited (`signal:child:`): the parent flow passes through the child and resumes from its
        // exits. Fire-and-forget (`spawn:`): the child runs below; the parent continues from here.
        const exits =
          isAwaitedChild(s.name) && sub.connectors.length > 0 ? sub.connectors : [{ id, failed }];
        return {
          id,
          exits,
          nextX: Math.max(x + gapX, sub.nextX),
          bottomY: Math.max(y, sub.bottomY),
        };
      }
      return { id, exits: [{ id, failed }], nextX: x + gapX, bottomY: y };
    }

    // Lay out a run's timeline starting at (startX, baseY) on lane `depth`. Consecutive steps sharing
    // a `parallelGroup` (a `ctx.gather`/`ctx.all` fan, e.g. processing's 7 handlers) are STACKED
    // VERTICALLY in one column — they ran concurrently, so they read as siblings rather than a
    // misleading parent→child chain. Sequential steps flow left-to-right as before. Returns the
    // first node id(s) (so the caller can link in — a fan-opening run has several), the exit
    // connectors (so the next step / `end` can link from), and the x/y extents consumed.
    function layout(
      tl: StepCheckpoint[],
      depth: number,
      startX: number,
      baseY: number,
      prefix: string,
      laneRun: WorkflowRun,
    ): { firstIds: string[]; connectors: FlowConnector[]; nextX: number; bottomY: number } {
      let cursorX = startX;
      const firstIds: string[] = [];
      let connectors: FlowConnector[] = [];
      let bottomY = baseY;
      for (const node of groupParallelSpans(tl)) {
        const members = node.kind === 'single' ? [node.step] : node.steps;
        const isFirstGroup = firstIds.length === 0;
        const exits: FlowConnector[] = [];
        let memberY = baseY;
        let groupNextX = cursorX;
        for (const s of members) {
          const placed = placeStep(s, cursorX, memberY, depth, prefix, laneRun);
          if (isFirstGroup) firstIds.push(placed.id);
          // Fan-out / sequential link: every prior exit connects into this member's entry node.
          for (const from of connectors) edges.push(mainEdge(from.id, placed.id, from.failed));
          exits.push(...placed.exits);
          groupNextX = Math.max(groupNextX, placed.nextX);
          memberY = placed.bottomY + FAN_ROW;
        }
        connectors = exits;
        cursorX = groupNextX;
        // `memberY` overshot one FAN_ROW past the last member — the real bottom is one step back.
        bottomY = Math.max(bottomY, memberY - FAN_ROW);
      }
      return { firstIds, connectors, nextX: cursorX, bottomY };
    }

    const gap0 = 248;
    nodes.push({
      id: 'start',
      type: 'terminal',
      position: { x: 0, y: 0 },
      draggable: false,
      data: { status: 'running', label: run.workflow } satisfies EndData,
    });
    const root = layout(timeline, 0, gap0, 0, '', run);
    // `start` fans out to every first node (a run that opens with a parallel fan has several).
    for (const firstId of root.firstIds) {
      edges.push({ id: `start->${firstId}`, source: 'start', target: firstId });
    }
    const shown = runDisplayStatus(run, timeline);
    nodes.push({
      id: 'end',
      type: 'terminal',
      position: { x: Math.max(root.nextX, gap0), y: 0 },
      draggable: false,
      data: { status: shown, label: shown } satisfies EndData,
    });
    // Every exit connector converges on `end` (a run that ENDS in a parallel fan has several).
    const exitConnectors: FlowConnector[] =
      root.connectors.length > 0 ? root.connectors : [{ id: 'start', failed: false }];
    for (const exit of exitConnectors) {
      edges.push({
        id: `${exit.id}->end`,
        source: exit.id,
        target: 'end',
        animated: live,
        style: { stroke: live ? 'var(--accent)' : 'var(--line)', strokeWidth: live ? 2 : 1.5 },
      });
    }

    return { nodes, edges };
  })();

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      if (node.type !== 'step') return;
      const data = node.data as StepData;
      // Open the detail for the clicked step — root or a nested child step (it carries its own
      // lane's run, so the panel renders the right run's timing/IO).
      if (data.step && data.laneRun) onSelect(data.step, data.laneRun);
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
