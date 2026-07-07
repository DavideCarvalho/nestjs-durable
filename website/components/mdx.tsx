import { CodeFlow } from '@/components/code-flow';
import { DlqSim, RetrySim } from '@/components/failure-sims';
import { QueueSim, SingletonSim } from '@/components/queue-sim';
import { AdaptiveSim, FanoutSim, RateLimitSim } from '@/components/scale-sims';
import { ReplayDiagram } from '@/components/replay-diagram';
import { Screenshot } from '@/components/screenshot';
import { TenancyDiagram } from '@/components/tenancy-diagram';
import { TenantFlow } from '@/components/tenant-flow';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    AdaptiveSim,
    CodeFlow,
    DlqSim,
    FanoutSim,
    QueueSim,
    RateLimitSim,
    RetrySim,
    SingletonSim,
    ReplayDiagram,
    Screenshot,
    TenancyDiagram,
    TenantFlow,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
