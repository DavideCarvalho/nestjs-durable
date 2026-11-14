import { forwardRef } from 'react';
import { badgeVariants as kitBadgeVariants } from '../../aviary-kit/ui/badge';
import { cn } from './cn';

/**
 * A non-interactive label chip: tags, the tenant/partition, `dlq`, search attributes, the workflow
 * version. The kit's shadcn `Badge` look (authkit `.badge`), under this console's own variant names,
 * each mapped onto a kit tone. The `status` variant is colourless on purpose — a run/step badge takes
 * its hue from the `s-<status>` class in `index.css`, the single place run status colour is defined.
 */
const VARIANT = {
  outline: 'neutral',
  /** Tenant / worker-pool partition. */
  tenant: 'info',
  /** The customer (organization) the run belongs to — data tenancy, not the worker pool. */
  organization: 'violet',
  /** The package that declared the run's workflow (`WorkflowRun.origin`): code provenance. */
  origin: 'teal',
  /** No package origin — the app's own workflow. Dim, with no hue. */
  'origin-unknown': 'neutral',
  /** Typed search attribute. */
  attr: 'violet',
  /** Dead-letter marker. */
  danger: 'destructive',
  /** Saga compensation marker. */
  warn: 'warn',
  /** Run/step status — colour comes from the caller's `s-<status>` class. */
  status: 'bare',
} as const;

export type BadgeVariant = keyof typeof VARIANT;

export function badgeVariants({
  variant = 'outline',
}: { variant?: BadgeVariant | null | undefined } = {}) {
  return cn(
    kitBadgeVariants({ variant: VARIANT[variant ?? 'outline'] }),
    variant === 'origin-unknown' && 'italic',
    variant === 'status' && 'gap-1.5',
  );
}

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant | null;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => (
    <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
  ),
);
Badge.displayName = 'Badge';
