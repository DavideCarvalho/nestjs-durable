import { forwardRef } from 'react';
import { buttonVariants as kitButtonVariants } from '../../aviary-kit/ui/button';
import { cn } from './cn';

/**
 * The console's button: the kit's shadcn `Button` look (authkit `.btn`), under the variant names
 * this console's call sites already use. Each tint is named after what it MEANS, so a new button
 * picks a meaning rather than re-deriving a colour.
 */
const VARIANT = {
  /** Neutral bordered action — the default (Cancel, run I/O). */
  outline: 'outline',
  /** Borderless, for close/clear affordances. */
  ghost: 'ghost',
  /** Bordered icon well (panel close buttons). */
  quiet: 'outline',
  /** The console accent — the primary recovery action (Retry). */
  brand: 'brand',
  /** Needs-attention amber (Continue at a breakpoint, Cancel + Undo). */
  warn: 'warn',
  /** Operational, non-destructive (Re-dispatch). */
  info: 'info',
  /** Branches off into a new run (Fix & replay, parent/original links). */
  alt: 'alt',
  /** Destructive bulk action (cancel all). */
  danger: 'destructive',
  /** A selectable chip in a row of chips (status filter, pod chips). */
  chip: 'chip',
} as const;

const SIZE = {
  /** Header actions. */
  sm: 'sm',
  /** Dense inline chips and mono micro-actions. */
  xs: 'micro',
  /** Filter chips / list-level actions. */
  chip: 'chip',
  /** Square icon well. */
  icon: 'icon-xs',
} as const;

export type ButtonVariant = keyof typeof VARIANT;
export type ButtonSize = keyof typeof SIZE;

export function buttonVariants({
  variant = 'outline',
  size = 'sm',
}: {
  variant?: ButtonVariant | null | undefined;
  size?: ButtonSize | null | undefined;
} = {}): string {
  return kitButtonVariants({
    variant: VARIANT[variant ?? 'outline'],
    size: SIZE[size ?? 'sm'],
  });
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant | null;
  size?: ButtonSize | null;
}

/**
 * A plain `<button>`. Composition goes the other way round with Base UI: a part renders THIS
 * (`<Dialog.Close render={<Button …/>} />`), merging its props in, so there is no `asChild` here.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type, ...props }, ref) => (
    <button
      ref={ref}
      // Never submit a form by accident — every button in this console is an action.
      type={type ?? 'button'}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
