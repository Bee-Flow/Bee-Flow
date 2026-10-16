import { useEffect, useState } from 'react';
import type { CsatStarsProps, SlaBadgeProps, TagChipsProps } from './SupportInboxPanel.types';

// Live-counting SLA badge. Green when comfortably ahead, amber within 30min of
// the due time, red once breached. Pauses (grey) when the thread waits on the
// customer or is already resolved/closed.
export function SlaBadge({ thread }: SlaBadgeProps) {
    const [, force] = useState(0);
    useEffect(() => {
        const t = setInterval(() => force(n => n + 1), 30000);
        return () => clearInterval(t);
    }, []);
    const dueAt = thread.sla_first_response_due_at && !thread.first_response_at
        ? thread.sla_first_response_due_at
        : thread.sla_resolution_due_at;
    const breached = thread.sla_first_response_breached_at || thread.sla_resolution_breached_at;
    if (!dueAt && !breached) return null;
    if (['resolved', 'closed'].includes(thread.status)) return null;

    let bg = 'rgba(16,185,129,0.12)', fg = '#059669', label: string;
    if (breached) {
        bg = 'rgba(239,68,68,0.15)'; fg = '#dc2626'; label = 'SLA breached';
    } else if (thread.sla_paused) {
        bg = 'var(--bg-tertiary)'; fg = 'var(--text-muted)'; label = 'SLA paused';
    } else {
        const ms = new Date(dueAt as string).getTime() - Date.now();
        const mins = Math.round(ms / 60000);
        if (mins <= 30) { bg = 'rgba(245,158,11,0.15)'; fg = '#b45309'; }
        if (mins < 0) { label = 'SLA breached'; bg = 'rgba(239,68,68,0.15)'; fg = '#dc2626'; }
        else if (mins < 60) label = `SLA ${mins}m`;
        else if (mins < 1440) label = `SLA ${Math.round(mins / 60)}h`;
        else label = `SLA ${Math.round(mins / 1440)}d`;
    }
    return <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: bg, color: fg }}>{label}</span>;
}

export function TagChips({ tags, onRemove }: TagChipsProps) {
    if (!Array.isArray(tags) || !tags.length) return null;
    return (
        <div className="flex items-center gap-1 flex-wrap">
            {tags.map(t => (
                <span key={t} className="text-xs px-1.5 py-0.5 rounded inline-flex items-center gap-1"
                    style={{ background: 'rgba(99,102,241,0.0)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}>
                    #{t}
                    {onRemove && (
                        <button onClick={() => onRemove(t)} className="opacity-60 hover:opacity-100 text-[var(--text-muted)]">×</button>
                    )}
                </span>
            ))}
        </div>
    );
}

export function CsatStars({ score }: CsatStarsProps) {
    if (!score) return null;
    return (
        <span className="text-xs inline-flex items-center" title={`Customer rated ${score}/5`} style={{ color: '#f59e0b' }}>
            {'★'.repeat(score)}<span className="text-[var(--text-muted)]">{'★'.repeat(5 - score)}</span>
        </span>
    );
}
