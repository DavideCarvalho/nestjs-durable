import { CodeFlow } from '@/components/code-flow';
import { ReplayDiagram } from '@/components/replay-diagram';
import { Screenshot } from '@/components/screenshot';
import { TenancyDiagram } from '@/components/tenancy-diagram';
import { TenantFlow } from '@/components/tenant-flow';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    CodeFlow,
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
