import { forwardRef } from 'react';
import { cn } from './cn';

/** The bare field. Borderless: every use sits inside a bordered composite that also holds a glyph
 *  and a clear button, and the ring belongs to that box so the whole thing reads as one control. */
export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'mono w-full bg-transparent py-1.5 text-xs text-fg placeholder:text-faint focus:outline-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
