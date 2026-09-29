// `popoverTrigger` (optional): when this pill is the toggle for a popover, set
// to a unique name that matches the popover's `triggerName` prop. The popover's
// outside-click handler then ignores clicks on this trigger so toggling
// works correctly (without it, the document mousedown listener and the
// trigger's onClick race and the popover stays open on close-click).
export default function ActionPill({ icon, label, count, onClick, active, popoverTrigger }) {
    return (
        <button
            onClick={onClick}
            data-popover-trigger={popoverTrigger || undefined}
            className={`group flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${active ? 'border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]' : 'border-[var(--border-default)] bg-[var(--bg-card,#fff)] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]'}`}
        >
            <span className={active ? '' : 'text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]'}>{icon}</span>
            <span>{label}</span>
            {(count !== undefined && count !== null && count > 0) && (
                <span className={`ml-0.5 text-[10px] font-semibold ${active ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]'}`}>
                    {count}
                </span>
            )}
        </button>
    );
}
