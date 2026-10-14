import type { CSSProperties } from 'react';

/** One aggregated model/agent row, or one recent call, as the usage endpoints return them. */
export interface UsageRow {
    model?: string;
    agent_name?: string;
    agent_type?: string;
    calls?: number;
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
    billed_cost?: number | string;
    estimated_cost?: number;
    timestamp?: string | number;
    duration_ms?: number;
    [key: string]: unknown;
}

/** Per-1M-token rates for one model. */
export interface ModelRate {
    input: number;
    output: number;
    cacheRead?: number;
}

export type DetailType = 'model' | 'agent';

export interface DrawerDetail {
    type: DetailType;
    data: UsageRow;
}

const BORDER_SUBTLE = '1px solid var(--border-default, rgba(255,255,255,0.06))';

export const S = {
    overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(4px)',
        animation: 'fadeIn 0.2s ease',
    },
    drawer: {
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: '480px',
        maxWidth: '90vw',
        zIndex: 1001,
        background: 'var(--bg-primary, #0f0f1a)',
        borderLeft: '1px solid var(--border-default, rgba(255,255,255,0.08))',
        display: 'flex',
        flexDirection: 'column',
        animation: 'slideInRight 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
    },
    header: {
        padding: '20px 24px',
        borderBottom: '1px solid var(--border-default, rgba(255,255,255,0.08))',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    closeButton: {
        width: '32px',
        height: '32px',
        borderRadius: '8px',
        border: '1px solid var(--border-default, rgba(255,255,255,0.1))',
        background: 'var(--bg-tertiary, #222)',
        color: 'var(--text-muted, #888)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '16px',
    },
    statGrid: {
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr',
        gap: '12px',
        padding: '16px 24px',
    },
    statBox: {
        padding: '14px',
        borderRadius: '12px',
        background: 'var(--bg-secondary, #1a1a2e)',
        border: BORDER_SUBTLE,
        textAlign: 'center',
    },
    statLabel: { fontSize: '10px', color: 'var(--text-muted, #888)', marginTop: '2px' },
    panel: {
        padding: '16px',
        borderRadius: '12px',
        background: 'var(--bg-secondary, #1a1a2e)',
        border: BORDER_SUBTLE,
    },
    sectionLabel: {
        fontSize: '11px',
        fontWeight: 600,
        color: 'var(--text-muted, #888)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
    },
    row: { display: 'flex', justifyContent: 'space-between' },
    rowLabel: { fontSize: '12px', color: 'var(--text-secondary, #aaa)' },
    rate: { fontSize: '12px', color: 'var(--text-muted, #888)' },
    divider: { borderTop: BORDER_SUBTLE, margin: '10px 0' },
    callCard: {
        padding: '10px 12px',
        borderRadius: '8px',
        background: 'var(--bg-secondary, #1a1a2e)',
        border: BORDER_SUBTLE,
        fontSize: '11px',
    },
} satisfies Record<string, CSSProperties>;
