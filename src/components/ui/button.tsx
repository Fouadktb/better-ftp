import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
export function Button({
  variant = 'outline',
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'outline' | 'ghost' | 'primary' | 'danger';
  ref?: Ref<HTMLButtonElement>;
}) {
  return <button type={type} className={`button button-${variant} ${className}`} {...props} />;
}
export function IconButton({
  label,
  children,
  ...props
}: Omit<Parameters<typeof Button>[0], 'children'> & { label: string; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <Button
          {...props}
          variant={props.variant || 'ghost'}
          className={`icon-button ${props.className || ''}`}
          aria-label={label}
        >
          {children}
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" sideOffset={7}>
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
