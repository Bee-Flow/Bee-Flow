interface InlineButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
    icon?: React.ComponentType<{ size?: number }> | null;
    label: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
}

/**
 * A bare inline ribbon button (icon + label) for flat toolbar rows.
 * `...rest` is spread onto the <button> so callers can add drag glue
 * (draggable/onDragStart) without this file knowing about it.
 */
export default function InlineButton({ icon: Icon = null, label, onClick, ...rest }: InlineButtonProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition"
            {...rest}
        >
            {Icon && <Icon size={14} />} {label}
        </button>
    );
}
