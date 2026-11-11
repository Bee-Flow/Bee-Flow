// The Runs view's presentation rules, pure: status tone, durations, cost per currency, who ran
// it, a step's label. No React, no network.

import type { TranslateFn } from '@/hooks/useTranslation';
import type { RunActor, RunStep } from './runsApi';

export type Tone = 'ok' | 'error' | 'warning' | 'neutral' | 'running';

export function statusTone(status: string): Tone {
    if (status === 'success' || status === 'ok') return 'ok';
    if (status === 'error') return 'error';
    if (status === 'running' || status === 'paused') return 'running';
    if (status === 'interrupted' || status === 'refused' || status === 'deferred') return 'warning';
    return 'neutral';
}

/** Tailwind classes per tone, on the theme variables. */
export const TONE_CLASS: Record<Tone, string> = {
    ok: 'text-[var(--success-ink)]',
    error: 'text-[var(--error)]',
    warning: 'text-[var(--warning-ink)]',
    running: 'text-[var(--accent-primary)]',
    neutral: 'text-[var(--text-secondary)]',
};

export function formatDuration(ms: number | null | undefined): string {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return `${m} min ${s} s`;
}

/** "$0.0021 · €0.0100", each in its own currency; '—' without a priced call. */
export function formatCost(costByCurrency: Record<string, number> | null | undefined, locale = 'en'): string {
    const entries = Object.entries(costByCurrency ?? {}).filter(([, v]) => Number.isFinite(v));
    if (!entries.length) return '—';
    return entries.map(([currency, value]) => {
        try {
            return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: value < 0.01 ? 4 : 2 }).format(value);
        } catch {
            return `${value.toFixed(4)} ${currency}`;
        }
    }).join(' · ');
}

export function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 10_000) return `${Math.round(n / 1000)}k`;
    return String(n);
}

export function actorText(actor: RunActor, t: TranslateFn): string {
    if (actor.isYou) return t('studio_apps_runs.actor.you', 'You');
    if (actor.kind === 'visitor') return t('studio_apps_runs.actor.visitor', 'Public visitor');
    if (actor.kind === 'system') return t('studio_apps_runs.actor.system', 'System (mailbox)');
    return actor.name || t('studio_apps_runs.actor.someone', 'A signed-in user');
}

export function originText(origin: string, t: TranslateFn): string {
    switch (origin) {
        case 'click': return t('studio_apps_runs.origin.click', 'Click');
        case 'public': return t('studio_apps_runs.origin.public', 'Public page');
        case 'mcp': return t('studio_apps_runs.origin.mcp', 'MCP test run');
        case 'test': return t('studio_apps_runs.origin.test', 'Saved test');
        case 'background': return t('studio_apps_runs.origin.background', 'Background job');
        case 'mailbox_hook': return t('studio_apps_runs.origin.mailbox_hook', 'New mail');
        default: return origin;
    }
}

export function statusText(status: string, t: TranslateFn): string {
    switch (status) {
        case 'success': return t('studio_apps_runs.status.success', 'Succeeded');
        case 'error': return t('studio_apps_runs.status.error', 'Failed');
        case 'running': return t('studio_apps_runs.status.running', 'Running');
        case 'paused': return t('studio_apps_durable.runs.status_paused', 'On hold');
        case 'interrupted': return t('studio_apps_runs.status.interrupted', 'Interrupted');
        case 'cancelled': return t('studio_apps_runs.status.cancelled', 'Cancelled');
        case 'refused': return t('studio_apps_runs.status.refused', 'Refused');
        case 'ok': return t('studio_apps_runs.status.ok', 'OK');
        case 'skipped': return t('studio_apps_runs.status.skipped', 'Skipped');
        case 'deferred': return t('studio_apps_runs.status.deferred', 'At the end');
        default: return status;
    }
}

/** "Step 3 · update_record", or "#4" when the server could not place the step. */
export function stepLabel(step: Pick<RunStep, 'path' | 'kind' | 'iteration'>, t: TranslateFn): string {
    const where = step.path.startsWith('#')
        ? t('studio_apps_runs.step.unplaced', 'Step {n}', { n: Number(step.path.slice(1)) + 1 })
        : step.path;
    const loop = step.iteration !== null && step.iteration !== undefined
        ? ` · ${t('studio_apps_runs.step.iteration', 'item {n}', { n: step.iteration + 1 })}` : '';
    return `${where} · ${step.kind}${loop}`;
}

/** The origins shown by default: what people did. Tests and MCP runs come in with the toggle. */
export const PEOPLE_ORIGINS = 'click,public,background,mailbox_hook';
