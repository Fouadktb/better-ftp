import * as Dropdown from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
export function Menu({
  trigger,
  children,
  label,
}: {
  trigger: ReactNode;
  children: ReactNode;
  label: string;
}) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>{trigger}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="menu-content" aria-label={label} sideOffset={5} align="end">
          {children}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
export function MenuItem({
  children,
  onSelect,
  disabled = false,
  danger = false,
}: {
  children: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <Dropdown.Item
      className={`menu-item ${danger ? 'destructive' : ''}`}
      onSelect={onSelect}
      disabled={disabled}
    >
      {children}
    </Dropdown.Item>
  );
}
export const MenuSeparator = () => <Dropdown.Separator className="menu-separator" />;
