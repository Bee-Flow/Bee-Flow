/**
 * One number with its name — the KPI tile. The whole tile is labelled for a
 * screen reader ("Responses in this period: 86"), the number is tabular so a
 * row of tiles lines up.
 */
export default function StatTile({ label, value, hint = null, testId }) {
    const text = value === null || value === undefined ? '—' : String(value);
    return (
        <div
            className="rounded-xl border p-4 min-w-0"
            style={{ background: 'var(--bg-card)', borderColor: 'var(--border-default)', boxShadow: 'var(--shadow-sm)' }}
            aria-label={`${label}: ${text}`}
            data-testid={testId}
        >
            <div className="text-2xl font-semibold tabular-nums truncate" style={{ color: 'var(--text-primary)' }}>{text}</div>
            <div className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{label}</div>
            {hint && <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{hint}</div>}
        </div>
    );
}
