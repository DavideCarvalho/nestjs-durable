import { ActionDialog } from '../../aviary-kit/blocks/action-dialog';

/**
 * The console's modal: the kit's `ActionDialog` (shadcn `Dialog` on Base UI) under the call-site
 * API this console uses — a title, a mono subtitle and an optional footer of actions.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  subtitle,
  footer,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <ActionDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      {...(subtitle ? { description: subtitle } : {})}
      {...(footer ? { footer } : {})}
      {...(className ? { className } : {})}
    >
      {children}
    </ActionDialog>
  );
}
