import type { LucideIcon } from 'lucide-react';

export interface ScreenMenuItemProps {
    icon: LucideIcon;
    label: string;
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
    title?: string | undefined;
}

/** One entry of a screen tab's kebab menu (ScreenTabs, ScreenOrderMenuItems). */
export default function ScreenMenuItem({ icon, label, onClick, disabled = false, danger = false, title }: ScreenMenuItemProps) {
    const Icon = icon;
    return (
        <button
            type="button"
            role="menuitem"
            disabled={disabled}
            title={title}
            onClick={onClick}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--bg-card-hover)] disabled:cursor-not-allowed disabled:opacity-40 ${danger ? 'text-[var(--error)]' : 'text-[var(--text-primary)]'}`}
        >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            {label}
        </button>
    );
}
