import { summariseData as summariseDataJs } from '../flow/dataSummary';
import { listBadgeClass as listBadgeClassJs } from '../flow/settings/formStyles';
import { MAX_CELL, safeJson, scalarText, truncate } from './valueHelpers';

const summariseData = summariseDataJs as (value: unknown) => { label?: string } | null;
const listBadgeClass = listBadgeClassJs as (extra?: string) => string;

// Compact single-cell rendering used inside tables and lists.
export default function InlineValue({ value }: { value: unknown }) {
    if (value === null || value === undefined) return <span className="text-[var(--text-tertiary)]">—</span>;
    if (Array.isArray(value)) {
        // An EMPTY list is a fact ("this email has no attachments"), not
        // missing data: it must never share the "—" no-data marker.
        if (value.length === 0) return <span className="text-[var(--text-tertiary)] italic">none</span>;
        if (value.every((v) => v === null || typeof v !== 'object')) {
            const joined = value.map(scalarText).join(', ');
            return <span title={joined}>{truncate(joined)}</span>;
        }
        // Real data in the same grey as the no-data marker read as absent:
        // the badge says "this is a list, and here is what it holds".
        return (
            <span className={listBadgeClass()} title={safeJson(value)}>
                {summariseData(value)?.label || `${value.length} item${value.length === 1 ? '' : 's'}`}
            </span>
        );
    }
    if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>);
        const parts = entries.slice(0, 3).map(([k, v]) => `${k}: ${typeof v === 'object' && v !== null ? '…' : truncate(scalarText(v), 24)}`);
        const more = entries.length > 3 ? ' …' : '';
        return <span className="text-[var(--text-secondary)]" title={safeJson(value)}>{truncate(parts.join(' · ') + more)}</span>;
    }
    const s = scalarText(value);
    return <span className="break-words" title={s.length > MAX_CELL ? s : undefined}>{truncate(s)}</span>;
}
