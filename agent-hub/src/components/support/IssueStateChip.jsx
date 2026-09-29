/**
 * A YouTrack issue's state, painted in the support inbox's own status colours.
 *
 * Deliberately the same palette the ticket list uses for its statuses, so a
 * Fixed issue and a Resolved ticket read as the same kind of "done" and an
 * agent never has to hold two colour languages in their head at once.
 * YouTrack state names are per-project, so anything unrecognised falls back to
 * neutral rather than guessing.
 */

const STATE_STYLE = {
    fixed: { bg: 'rgba(16,185,129,0.12)', fg: '#059669' },
    resolved: { bg: 'rgba(16,185,129,0.12)', fg: '#059669' },
    verified: { bg: 'rgba(16,185,129,0.12)', fg: '#059669' },
    done: { bg: 'rgba(16,185,129,0.12)', fg: '#059669' },
    'in progress': { bg: 'rgba(14,165,233,0.12)', fg: '#0284c7' },
    'to verify': { bg: 'rgba(14,165,233,0.12)', fg: '#0284c7' },
    open: { bg: 'rgba(59,130,246,0.12)', fg: '#2563eb' },
    submitted: { bg: 'rgba(59,130,246,0.12)', fg: '#2563eb' },
    reopened: { bg: 'rgba(245,158,11,0.15)', fg: '#b45309' },
    'won\'t fix': { bg: 'var(--bg-tertiary)', fg: 'var(--text-muted)' },
    duplicate: { bg: 'var(--bg-tertiary)', fg: 'var(--text-muted)' },
};

function stateStyle(state) {
    return STATE_STYLE[String(state || '').toLowerCase()]
        || { bg: 'var(--bg-tertiary)', fg: 'var(--text-secondary)' };
}

export default function IssueStateChip({ state, resolved }) {
    const label = state || (resolved ? 'Resolved' : 'Unknown');
    const s = stateStyle(label);
    return (
        <span className="text-xs px-1.5 py-0.5 rounded shrink-0" style={{ background: s.bg, color: s.fg }}>
            {label}
        </span>
    );
}
