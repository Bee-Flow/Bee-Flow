import { Activity, Bot } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { UsageRow } from './drawer/drawerTypes';

/** Per-1M-token rate entry; every field optional so a partial rate table still prices. */
export interface RateEntry {
    input?: number;
    output?: number;
    cacheRead?: number;
}


export interface SourceDetails {
    label: string;
    icon: LucideIcon;
    color: string;
}

export interface AgentStyle {
    bg: string;
    text: string;
    label: string;
}

// ── Formatters ──────────────────────────────────────────────────────────────

export function fmt(n: number | null | undefined): string {
    if (n == null) return '0';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(Math.round(n));
}

export function fmtCost(n: number | null | undefined): string {
    if (!n || n === 0) return '$0.00';
    if (n >= 1) return '$' + n.toFixed(2);
    if (n >= 0.01) return '$' + n.toFixed(3);
    if (n >= 0.001) return '$' + n.toFixed(4);
    return '$' + n.toFixed(6);
}

// Cache-aware provider cost (USD) for a usage row, given its rate entry `c`
// ({ input, output, cacheRead } per 1M tokens from the model-costs map).
// Cached input tokens are billed at the cached rate, not the full input rate —
// matches the backend computeCost. Falls back gracefully when cacheRead or
// cached_tokens are absent (e.g. redacted non-admin rows → cached defaults 0).
export function rowCost(row: UsageRow | null | undefined, c: RateEntry): number;
export function rowCost(row: UsageRow | null | undefined, c: RateEntry | null | undefined): number | null;
export function rowCost(row: UsageRow | null | undefined, c: RateEntry | null | undefined): number | null {
    if (!c) return null;
    const prompt = row?.prompt_tokens || 0;
    const completion = row?.completion_tokens || 0;
    const cached = row?.cached_tokens || 0;
    const uncached = Math.max(0, prompt - cached);
    const cacheRead = c.cacheRead ?? 0;
    const cacheRate = cacheRead > 0 ? cacheRead : (c.input || 0);
    return (uncached / 1e6) * (c.input || 0)
        + (cached / 1e6) * cacheRate
        + (completion / 1e6) * (c.output || 0);
}

export function fmtDuration(ms: number | null | undefined): string {
    if (!ms) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

export function fmtTime(ts: string | number | null | undefined): string {
    if (!ts) return '—';
    const d = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60_000) return 'just now';
    if (diff < 3600_000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function fmtPct(n: number | null | undefined): string {
    if (!n && n !== 0) return '—';
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(1)}%`;
}

export function shortModel(m: string | null | undefined): string {
    if (!m) return 'Unknown';
    return m.replace(/^(openai\/|anthropic\/|google\/|azure\/|mistral\/)/, '')
        .replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

// ── Colors ──────────────────────────────────────────────────────────────────

export const COLORS = {
    primary: '#6366f1',
    purple: '#8b5cf6',
    blue: '#3b82f6',
    green: '#10b981',
    emerald: '#059669',
    amber: '#f59e0b',
    orange: '#f97316',
    rose: '#f43f5e',
    pink: '#ec4899',
    cyan: '#06b6d4',
    teal: '#14b8a6',
};

export const AGENT_COLORS: Record<string, AgentStyle> = {
    chat: { bg: '#6366f115', text: '#818cf8', label: '💬 Chat' },
    system: { bg: '#8b5cf615', text: '#a78bfa', label: '⚙️ System' },
};

export function getAgentStyle(type: string | null | undefined): AgentStyle {
    return AGENT_COLORS[type as string] || AGENT_COLORS.chat;
}

export const MODEL_COLORS = [
    '#6366f1', '#8b5cf6', '#3b82f6', '#06b6d4', '#10b981',
    '#f59e0b', '#f97316', '#ec4899', '#f43f5e', '#14b8a6',
];

export const SOURCE_MAP: Record<string, SourceDetails> = {
    agent: { label: 'Agent Chat', icon: Bot, color: '#6366f1' },
    chat: { label: 'Agent Chat', icon: Bot, color: '#6366f1' },
    direct: { label: 'Direct Chat', icon: Activity, color: '#10b981' },
    notebook: { label: 'Notebooks', icon: Activity, color: '#8b5cf6' },
    research: { label: 'Research', icon: Activity, color: '#f59e0b' },
    template: { label: 'Templates', icon: Activity, color: '#ef4444' },
    designer: { label: 'App Designer', icon: Activity, color: '#0ea5e9' },
    agent_stream: { label: 'Agent Stream', icon: Bot, color: '#6366f1' },
};
export const getSourceDetails = (source: string | null | undefined): SourceDetails =>
    SOURCE_MAP[source as string] || { label: source || 'Other', icon: Activity, color: '#94a3b8' };

