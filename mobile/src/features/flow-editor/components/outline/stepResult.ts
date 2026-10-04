/**
 * One short phrase for what a run step produced — the result chip a card
 * wears once its row has settled. A port of the web builder's
 * flow/stepResultChip.js, pinned by stepResult.lockstep.test.ts
 * (differential). Counts and shapes only: a chip never shows a value, so it
 * can never leak what a step read.
 */

import type { Translate } from '@/features/flow-editor/model';

const LIST_KEYS = ['files', 'items', 'results', 'rows', 'events', 'entries'] as const;
const OK_FLAGS = ['created', 'uploaded', 'sent'] as const;
const OPEN_STATES = new Set(['running', 'queued', 'pending']);

function listChip(key: string, n: number, t: Translate): string {
    if (n === 0) return t('automations.canvas.result.empty', 'nothing');
    if (key === 'files') return t('automations.canvas.result.files', '{n} files', { n });
    if (key === 'rows') return t('automations.canvas.result.rows', '{n} rows', { n });
    return t('automations.canvas.result.items', '{n} items', { n });
}

function objectChip(out: Record<string, unknown>, t: Translate): string {
    // A server-truncated output is a placeholder, not a shape to count.
    if (out.__truncated__ === true) return t('automations.canvas.result.ok', 'done');
    for (const key of LIST_KEYS) {
        const list = out[key];
        if (Array.isArray(list)) return listChip(key, list.length, t);
    }
    if (out.appended === true || OK_FLAGS.some((f) => !!out[f])) return t('automations.canvas.result.ok', 'done');
    if (Object.keys(out).length === 0) return t('automations.canvas.result.empty', 'nothing');
    return t('automations.canvas.result.ok', 'done');
}

/** Null while the step is still going (the status badge says so) or with no row at all. */
export function describeStepResult(row: { status?: unknown; output?: unknown } | null | undefined, t: Translate | null): string | null {
    if (!row || typeof t !== 'function') return null;
    const status = String(row.status || '').toLowerCase();
    if (!status || OPEN_STATES.has(status) || status.startsWith('awaiting')) return null;
    if (status === 'error' || status === 'failed') return t('automations.canvas.result.failed', 'failed');
    if (status === 'skipped') return t('automations.canvas.result.skipped', 'skipped');
    const out = row.output;
    if (out == null) return t('automations.canvas.result.empty', 'nothing');
    if (Array.isArray(out)) return listChip('items', out.length, t);
    if (typeof out === 'string') {
        return out.length > 0 ? t('automations.canvas.result.chars', '{n} characters', { n: out.length }) : t('automations.canvas.result.empty', 'nothing');
    }
    if (typeof out === 'object') return objectChip(out as Record<string, unknown>, t);
    // A number or a boolean: the step produced a value.
    return t('automations.canvas.result.ok', 'done');
}
