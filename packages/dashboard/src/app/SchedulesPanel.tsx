import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ScheduleSummary, durableClient } from '../client/durable-client';
import { Button } from './ui/button';
import { cn } from './ui/cn';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

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

/**
 * The persisted schedules (`engine.schedules`) as a header chip: count + a popover listing each one's
 * cadence, next fire, last run and error, with pause/resume and "run now". Renders nothing when there
 * are none (or the store doesn't persist schedules, or this is a tenant deployment).
 */
export function SchedulesPanel() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['schedules'],
    queryFn: () => durableClient.schedules(),
    refetchInterval: 10_000,
  });
  const act = useMutation({
    mutationFn: ({
      id,
      action,
    }: { id: string; action: 'pause' | 'resume' | 'trigger' }): Promise<unknown> =>
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
  if (!data || data.length === 0) return null;
  const paused = data.filter((s) => s.paused).length;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="chip" size="xs" className="mono gap-1">
            <span className="uppercase tracking-wide">schedules</span>
            <span className="tnum text-zinc-500">
              {data.length}
              {paused ? ` · ${paused} paused` : ''}
            </span>
          </Button>
        }
      />
      <PopoverContent className="w-[34rem] max-h-[60vh] overflow-y-auto">
        <table className="mono w-full text-[10px]">
          <thead className="sticky top-0 bg-popover text-left text-zinc-500">
            <tr>
              <th className="px-2 py-1.5 font-normal">schedule</th>
              <th className="px-2 py-1.5 font-normal">cadence</th>
              <th className="px-2 py-1.5 font-normal">next</th>
              <th className="px-2 py-1.5 font-normal">last</th>
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.id} className="border-t border-line align-top">
                <td className="max-w-[10rem] px-2 py-1.5">
                  <div className="truncate text-zinc-200" title={s.id}>
                    {s.id}
                  </div>
                  <div className="truncate text-zinc-500" title={s.workflow}>
                    {s.workflow}
                    {s.namespace !== 'default' ? ` @${s.namespace}` : ''}
                  </div>
                </td>
                <td className="px-2 py-1.5 text-zinc-400">{cadenceLabel(s)}</td>
                <td className={cn('px-2 py-1.5', s.paused ? 'text-amber-400/80' : 'text-zinc-300')}>
                  {s.paused ? 'paused' : s.nextFireAt ? relativeTo(s.nextFireAt) : '—'}
                </td>
                <td className="max-w-[9rem] px-2 py-1.5 text-zinc-500">
                  {s.lastFireAt ? relativeTo(s.lastFireAt) : 'never'}
                  {s.lastError && (
                    <div className="truncate text-red-400/80" title={s.lastError}>
                      {s.lastError}
                    </div>
                  )}
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right">
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={act.isPending}
                    onClick={() => act.mutate({ id: s.id, action: s.paused ? 'resume' : 'pause' })}
                  >
                    {s.paused ? 'resume' : 'pause'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={act.isPending}
                    onClick={() => act.mutate({ id: s.id, action: 'trigger' })}
                  >
                    run now
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </PopoverContent>
    </Popover>
  );
}
