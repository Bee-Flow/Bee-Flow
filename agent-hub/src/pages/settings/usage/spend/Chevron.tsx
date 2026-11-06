/** The open/closed marker of an expandable row. */
export function Chevron({ open }: { open: boolean }) {
    return (
        <span aria-hidden="true" className={`inline-block w-2.5 text-[var(--text-muted)] transition-transform ${open ? 'rotate-90 text-[var(--text-primary)]' : ''}`}>›</span>
    );
}
