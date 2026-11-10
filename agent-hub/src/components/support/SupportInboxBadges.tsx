import { useEffect, useState } from 'react';
import { CHIP, CHIP_ERROR, CHIP_SUCCESS, CHIP_WARNING } from '../mcpLibrary/ui';
import type { CsatStarsProps, SlaBadgeProps, TagChipsProps } from './SupportInboxPanel.types';

// Live-counting SLA badge. Green when comfortably ahead, amber within 30min of
// the due time, red once breached. Pauses (grey) when the thread waits on the
// customer or is already resolved/closed.
export function SlaBadge({ thread }: SlaBadgeProps) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 30000);
        return () => clearInterval(t);
    }, []);
    const dueAt = thread.sla_first_response_due_at && !thread.first_response_at
        ? thread.sla_first_response_due_at
        : thread.sla_resolution_due_at;
    const breached = thread.sla_first_response_breached_at || thread.sla_resolution_breached_at;
    if (!dueAt && !breached) return null;
    if (['resolved', 'closed'].includes(thread.status)) return null;

    let cls = CHIP_SUCCESS, label: string;
    if (breached) {
        cls = CHIP_ERROR; label = 'SLA breached';
    } else if (thread.sla_paused) {
        cls = CHIP; label = 'SLA paused';
    } else {
        const ms = new Date(dueAt as string).getTime() - now;
        const mins = Math.round(ms / 60000);
        if (mins <= 30) cls = CHIP_WARNING;
        if (mins < 0) { label = 'SLA breached'; cls = CHIP_ERROR; }
        else if (mins < 60) label = `SLA ${mins}m`;
        else if (mins < 1440) label = `SLA ${Math.round(mins / 60)}h`;
        else label = `SLA ${Math.round(mins / 1440)}d`;
    }
    return <span className={cls}>{label}</span>;
}

export function TagChips({ tags, onRemove }: TagChipsProps) {
    if (!Array.isArray(tags) || !tags.length) return null;
    return (
        <div className="flex items-center gap-1 flex-wrap">
            {tags.map(t => (
                <span key={t} className={CHIP}>
                    #{t}
                    {onRemove && (
                        <button onClick={() => onRemove(t)} className="text-[var(--text-tertiary)] opacity-60 hover:opacity-100">×</button>
                    )}
                </span>
            ))}
        </div>
    );
}

export function CsatStars({ score }: CsatStarsProps) {
    if (!score) return null;
    return (
        <span className="inline-flex items-center text-xs text-[var(--warning)]" title={`Customer rated ${score}/5`}>
            {'★'.repeat(score)}<span className="text-[var(--text-tertiary)]">{'★'.repeat(5 - score)}</span>
        </span>
    );
}
