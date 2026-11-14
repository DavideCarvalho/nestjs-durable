import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DataTable } from '../aviary-kit/blocks/data-table';
import { EmptyState } from '../aviary-kit/blocks/empty-state';
import { ErrorBoundary, RegionError } from '../aviary-kit/blocks/error-boundary';
import { MetricCard, MetricGrid, MetricGridSkeleton } from '../aviary-kit/blocks/metric-card';
import { PageHeader } from '../aviary-kit/blocks/page-header';
import { Panel } from '../aviary-kit/blocks/panel';
import { ClockIcon } from '../aviary-kit/icons';
import { PageBody } from '../aviary-kit/shell/app-shell';
import { Badge } from '../aviary-kit/ui/badge';
import { type ScheduleSummary, durableClient } from '../client/durable-client';
import { Button } from './ui/button';
import { cn } from './ui/cn';

/** "every 15m" / "0 9 * * 1-5 · America/Sao_Paulo" — the cadence as one line. */
export function cadenceLabel(s: Pick<ScheduleSummary, 'cron' | 'everyMs' | 'timezone'>): string {
  if (s.cron) return s.timezone && s.timezone !== 'UTC' ? `${s.cron} · ${s.timezone}` : s.cron;
  const ms = s.everyMs ?? 0;
  if (ms % 86_400_000 === 0) return `every ${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `every ${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `every ${ms / 1_000}s`;
  return `every ${ms}ms`;
}

/** "in 4m" / "3h ago" relative to now, for an ISO instant. */
export function relativeTo(iso: string, now = Date.now()): string {
  const delta = Date.parse(iso) - now;
  const s = Math.round(Math.abs(delta) / 1000);
  const span =
    s < 60
      ? `${s}s`
      : s < 3_600
        ? `${Math.round(s / 60)}m`
        : s < 86_400
          ? `${Math.round(s / 3_600)}h`
          : `${Math.round(s / 86_400)}d`;
  return delta >= 0 ? `in ${span}` : `${span} ago`;
}

type ScheduleAction = 'pause' | 'resume' | 'trigger';

/**
 * Schedules (OPERATIONS): the persisted schedules (`engine.schedules`) — each one's cadence, next
 * fire, last run and error, with pause/resume and "run now". Absent from the nav on a tenant
 * deployment (its gateway has no runtime schedule control).
 *
 * Container: owns the `/schedules` poll and the three actions; {@link SchedulesView} is pure props.
 */
export function SchedulesPanel() {
  const queryClient = useQueryClient();
  const schedules = useQuery({
    queryKey: ['schedules'],
    queryFn: () => durableClient.schedules(),
    refetchInterval: 10_000,
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: ScheduleAction }): Promise<unknown> =>
      action === 'pause'
        ? durableClient.pauseSchedule(id)
        : action === 'resume'
          ? durableClient.resumeSchedule(id)
          : durableClient.triggerSchedule(id),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['schedules'] });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
  });
  return (
    <SchedulesView
      schedules={schedules.data}
      error={schedules.data === undefined ? schedules.error : null}
      onRetry={() => void schedules.refetch()}
      busy={act.isPending}
      onAction={(id, action) => act.mutate({ id, action })}
    />
  );
}

export function SchedulesView({
  schedules,
  error,
  onRetry,
  busy,
  onAction,
}: {
  schedules: ScheduleSummary[] | undefined;
  error: unknown;
  onRetry: () => void;
  busy: boolean;
  onAction: (id: string, action: ScheduleAction) => void;
}) {
  const paused = schedules?.filter((s) => s.paused).length ?? 0;
  const failing = schedules?.filter((s) => s.lastError).length ?? 0;
  const next = schedules
    ?.filter((s) => !s.paused && s.nextFireAt)
    .map((s) => s.nextFireAt as string)
    .sort()[0];
  return (
    <PageBody>
      <PageHeader
        title="Schedules"
        description="Cron and interval schedules the engine persists: cadence, next fire, last run."
      />
      <ErrorBoundary label="Schedule summary">
        {error ? (
          <RegionError title="Schedules could not be loaded" error={error} onRetry={onRetry} />
        ) : schedules ? (
          <MetricGrid>
            <MetricCard
              label="Schedules"
              value={schedules.length}
              tone="brand"
              caption="persisted"
            />
            <MetricCard
              label="Active"
              value={schedules.length - paused}
              tone="good"
              caption={next ? `next ${relativeTo(next)}` : 'nothing due'}
            />
            <MetricCard
              label="Paused"
              value={paused}
              tone={paused > 0 ? 'warn' : 'default'}
              caption="not firing"
            />
            <MetricCard
              label="Failing"
              value={failing}
              tone={failing > 0 ? 'bad' : 'default'}
              caption="last fire errored"
            />
          </MetricGrid>
        ) : (
          <MetricGridSkeleton count={4} />
        )}
      </ErrorBoundary>
      <ErrorBoundary label="Schedules">
        <Panel title="All schedules" description="pause, resume or fire one now" flush>
          <DataTable
            label="Schedules"
            rows={error ? [] : schedules}
            loading={schedules === undefined && !error}
            rowKey={(s) => s.id}
            empty={
              <EmptyState
                icon={<ClockIcon />}
                title="No schedules"
                description="Nothing is scheduled, or this store does not persist schedules."
              />
            }
            columns={[
              {
                id: 'schedule',
                header: 'Schedule',
                cell: (s) => (
                  <div className="flex min-w-0 flex-col">
                    <span className="mono truncate text-[12px] text-fg" title={s.id}>
                      {s.id}
                    </span>
                    <span className="mono truncate text-[10.5px] text-dim" title={s.workflow}>
                      {s.workflow}
                      {s.namespace !== 'default' ? ` @${s.namespace}` : ''}
                    </span>
                  </div>
                ),
              },
              {
                id: 'cadence',
                header: 'Cadence',
                hideBelow: 'sm',
                cell: (s) => (
                  <span className="mono text-[11.5px] text-fg-2">{cadenceLabel(s)}</span>
                ),
              },
              {
                id: 'next',
                header: 'Next',
                cell: (s) =>
                  s.paused ? (
                    <Badge variant="warn">paused</Badge>
                  ) : (
                    <span className="mono text-[11.5px] text-fg-2">
                      {s.nextFireAt ? relativeTo(s.nextFireAt) : '—'}
                    </span>
                  ),
              },
              {
                id: 'last',
                header: 'Last',
                hideBelow: 'md',
                className: 'max-w-[16rem] whitespace-normal',
                cell: (s) => (
                  <div className="flex min-w-0 flex-col">
                    <span className="mono text-[11.5px] text-dim">
                      {s.lastFireAt ? relativeTo(s.lastFireAt) : 'never'}
                    </span>
                    {s.lastError && (
                      <span className="mono truncate text-[10.5px] text-bad" title={s.lastError}>
                        {s.lastError}
                      </span>
                    )}
                  </div>
                ),
              },
              {
                id: 'actions',
                header: <span className="sr-only">Actions</span>,
                align: 'right',
                cell: (s) => (
                  <div className={cn('flex justify-end gap-1.5')}>
                    <Button
                      variant="chip"
                      size="xs"
                      disabled={busy}
                      onClick={() => onAction(s.id, s.paused ? 'resume' : 'pause')}
                    >
                      {s.paused ? 'resume' : 'pause'}
                    </Button>
                    <Button
                      variant="brand"
                      size="xs"
                      disabled={busy}
                      onClick={() => onAction(s.id, 'trigger')}
                    >
                      run now
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        </Panel>
      </ErrorBoundary>
    </PageBody>
  );
}
