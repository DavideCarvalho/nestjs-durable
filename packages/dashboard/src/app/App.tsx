import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorBoundary } from '../aviary-kit/blocks/error-boundary';
import { ActivityIcon, ClockIcon, ServerIcon } from '../aviary-kit/icons';
import { readShellConfig } from '../aviary-kit/shell-config';
import { AppShell, type NavSection, PageBody } from '../aviary-kit/shell/app-shell';
import type { SearchCommand } from '../aviary-kit/shell/console-search';
import { SchedulesPanel } from './SchedulesPanel';
import { WorkflowPage } from './WorkflowLifecycle';
import { supports, useTopology } from './capabilities';
import { type Route, currentRoute, pushRoute } from './routes';
import { LogoMark } from './run-status';
import { RunsPage, useRunFilters } from './runs/RunsPage';
import { WorkersPage } from './workers/WorkersPage';

/** The id of the page's JSON config block (the server's `DURABLE_DASHBOARD_CONFIG_ID`). */
export const CONFIG_ELEMENT_ID = 'durable-dashboard-config';

/** Durable's accent (lime): passed to the kit's ThemeProvider in `main.tsx`. */
export const DURABLE_ACCENT = '#a3e635';

const TITLES: Record<Route['page'], string> = {
  runs: 'Runs',
  workers: 'Workers',
  schedules: 'Schedules',
  workflow: 'Workflow',
};

function LiveIndicator() {
  return (
    <span className="hidden items-center gap-1.5 text-[12px] text-dim sm:flex">
      <span className="dot s-completed pulse" aria-hidden />
      live
    </span>
  );
}

/**
 * The durable console: the Aviary shell (kit) around three pages — MONITOR (Runs, Workers) and
 * OPERATIONS (Schedules, absent on a tenant deployment, whose gateway has no runtime schedule
 * control) — plus a workflow's page. Every page and region renders inside its own error boundary.
 */
export function App() {
  // What the server put in the page: switcher, ⌘K search, viewer, sign-out (all optional).
  const shell = useMemo(() => readShellConfig(CONFIG_ELEMENT_ID), []);
  const filters = useRunFilters();
  const [route, setRouteState] = useState<Route>(() => currentRoute());

  const navigate = useCallback((next: Route) => {
    setRouteState(next);
    pushRoute(next);
  }, []);
  // Every "open this run" affordance funnels here: it always lands on the runs board.
  const openRun = useCallback((id: string) => navigate({ page: 'runs', runId: id }), [navigate]);
  const selectRun = useCallback(
    (id?: string) => navigate(id ? { page: 'runs', runId: id } : { page: 'runs' }),
    [navigate],
  );
  // Follow back/forward and external hash edits.
  useEffect(() => {
    const sync = () => setRouteState(currentRoute());
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);

  // Topology is fixed for a deployment's lifetime: fetched once. The role is the capability signal.
  const topology = useTopology();
  const isTenant = topology?.role === 'tenant';
  const roleLabel = !topology
    ? ' '
    : topology.engine
      ? topology.engine
      : isTenant
        ? topology.tenant
          ? `tenant · ${topology.tenant}`
          : 'tenant'
        : 'control plane';
  const showSchedules = !isTenant && supports(topology, 'schedules');
  const showWorkers = supports(topology, 'workers');

  const nav = useMemo<NavSection[]>(
    () => [
      {
        section: 'Monitor',
        items: [
          {
            id: 'runs',
            label: 'Runs',
            icon: <ActivityIcon />,
            href: '#/',
            onSelect: () => navigate({ page: 'runs' }),
          },
          ...(showWorkers
            ? [
                {
                  id: 'workers',
                  label: 'Workers',
                  icon: <ServerIcon />,
                  href: '#/workers',
                  onSelect: () => navigate({ page: 'workers' }),
                },
              ]
            : []),
        ],
      },
      {
        section: 'Operations',
        items: showSchedules
          ? [
              {
                id: 'schedules',
                label: 'Schedules',
                icon: <ClockIcon />,
                href: '#/schedules',
                onSelect: () => navigate({ page: 'schedules' }),
              },
            ]
          : [],
      },
    ],
    [showWorkers, showSchedules, navigate],
  );

  // ⌘K: this console's pages, listed above the cross-console hits.
  const commands = useMemo<SearchCommand[]>(
    () =>
      nav.flatMap((section) =>
        section.items.map((item) => ({
          id: `page:${item.id}`,
          label: item.label,
          group: 'Pages',
          icon: item.icon,
          keywords: [section.section],
          onSelect: () => item.onSelect?.(),
        })),
      ),
    [nav],
  );

  const activeId = route.page === 'workflow' ? 'runs' : route.page;
  const title = route.page === 'workflow' ? route.workflow : TITLES[route.page];

  return (
    <AppShell
      brand={{
        name: 'durable',
        subtitle: (
          <span
            className={isTenant ? 'text-warn' : undefined}
            title={
              isTenant
                ? `Tenant deployment — partition ${topology?.tenant ?? '(unnamed)'}`
                : 'Control-plane deployment'
            }
          >
            {roleLabel}
          </span>
        ),
        mark: <LogoMark />,
        current: { title: 'Workflows', package: '@dudousxd/nestjs-durable', icon: 'workflow' },
      }}
      nav={nav}
      activeId={activeId}
      shell={shell}
      title={title}
      commands={commands}
      searchPlaceholder="Search runs, workflows, media, threads…"
      contentClassName={route.page === 'runs' ? 'overflow-hidden' : undefined}
      actions={<LiveIndicator />}
    >
      <ErrorBoundary label={TITLES[route.page]} resetKeys={[route.page]}>
        {route.page === 'workflow' ? (
          <PageBody>
            <WorkflowPage key={route.workflow} workflow={route.workflow} />
          </PageBody>
        ) : route.page === 'schedules' && showSchedules ? (
          <SchedulesPanel />
        ) : route.page === 'workers' && showWorkers ? (
          <WorkersPage />
        ) : (
          <RunsPage
            filters={filters}
            selected={route.page === 'runs' ? route.runId : undefined}
            onSelect={selectRun}
            onOpenRun={openRun}
          />
        )}
      </ErrorBoundary>
    </AppShell>
  );
}
