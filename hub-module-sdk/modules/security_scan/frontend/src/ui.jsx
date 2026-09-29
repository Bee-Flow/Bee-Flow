/**
 * Small presentational helpers inlined from the host so the module imports
 * nothing from agent-hub/src.
 *
 * - StudioShell: the two-pane (sidebar + main) Studio chrome. Minimal copy of
 *   components/shared/StudioShell.tsx.
 * - StatusDot: the colored status dot for run outcomes.
 *   Palette stays amber/emerald/red/slate — no purple.
 */

/** Two-pane Studio layout: left sidebar + main content. */
export function StudioShell({
    sidebarTitle,
    sidebarActions,
    sidebar,
    children,
    sidebarWidthClass = 'w-64',
    className = '',
}) {
    return (
        <div className={`flex h-full bg-[var(--bg-primary)] ${className}`}>
            <aside className={`${sidebarWidthClass} flex-shrink-0 border-r border-[var(--border-default)] flex flex-col`}>
                {(sidebarTitle != null || sidebarActions != null) && (
                    <header className="px-4 py-3 border-b border-[var(--border-default)] flex items-center justify-between">
                        <span className="text-sm font-semibold text-[var(--text-primary)] truncate">
                            {sidebarTitle}
                        </span>
                        {sidebarActions != null && (
                            <div className="flex-shrink-0">{sidebarActions}</div>
                        )}
                    </header>
                )}
                <div className="flex-1 overflow-y-auto">{sidebar}</div>
            </aside>
            <main className="flex-1 overflow-y-auto">{children}</main>
        </div>
    );
}

/** Small colored status dot. */
export function StatusDot({ status }) {
    const color = status === 'passed' ? 'bg-emerald-500'
        : status === 'failed' ? 'bg-red-500'
        : status === 'running' || status === 'queued' ? 'bg-amber-500'
        : status === 'error' ? 'bg-amber-600'
        : 'bg-[var(--text-tertiary)]';
    return <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${color}`} title={status} />;
}

export default StudioShell;
