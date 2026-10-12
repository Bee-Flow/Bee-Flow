/**
 * "How much, and what kind" — one sentence about a step's data. Port of
 * `summariseData` from agent-hub `Builder/flow/dataSummary.js` (the part
 * listShape reads). Pinned by flowDeps.lockstep.test.ts.
 */

import { translate as t } from '@/core/i18n';

import { isObj } from '../json';

export interface DataSummary {
    count: number;
    kind: string;
    label: string;
    total?: number;
    title?: string;
}

// Keys that conventionally hold "the actual list" inside a result envelope.
const LIST_KEYS = ['items', 'results', 'rows', 'records', 'messages', 'values', 'data', 'entries', 'files'];

/** Text longer than this is worth reporting a character count for. */
const LONG_TEXT = 60;

function recordsLabel(n: number): string {
    return n === 1 ? t('automations.canvas_legend.1_record', '1 record') : t('mobile.flow.summary.records', '{n} records', { n });
}

function itemsLabel(n: number): string {
    return n === 1 ? t('automations.builder.one_item', '1 item') : t('automations.canvas.result.items', '{n} items', { n });
}

/** Is every element (that we sampled) an object? Then it reads as records. */
function looksTabular(list: unknown[]): boolean {
    const sample = list.slice(0, 20).filter((v) => v !== null && v !== undefined);
    if (!sample.length) return false;
    const objects = sample.filter((v) => typeof v === 'object' && !Array.isArray(v));
    return objects.length >= sample.length / 2;
}

function fromArray(list: unknown[]): DataSummary {
    if (looksTabular(list)) return { count: list.length, kind: 'records', label: recordsLabel(list.length) };
    return { count: list.length, kind: 'items', label: itemsLabel(list.length) };
}

function envelopeList(value: Record<string, unknown>): { list: unknown[]; conventional: boolean } | null {
    for (const k of LIST_KEYS) {
        const v = value[k];
        if (Array.isArray(v)) return { list: v, conventional: true };
    }
    const arrays = Object.entries(value)
        .filter(([k, v]) => Array.isArray(v) && k !== 'branches')
        .map(([, v]) => v as unknown[]);
    return arrays.length === 1 ? { list: arrays[0] as unknown[], conventional: false } : null;
}

/** "10 of 201 records" — only for a whole `total` above what came back. */
function withTotal(summary: DataSummary, total: unknown): DataSummary {
    if (!Number.isInteger(total) || (total as number) <= summary.count) return summary;
    const noun = summary.kind === 'records' || summary.kind === 'record' ? 'records' : 'items';
    return {
        ...summary,
        total: total as number,
        label: noun === 'records'
            ? t('mobile.flow.summary.records_of_total', '{n} of {total} records', { n: summary.count, total: total as number })
            : t('mobile.flow.summary.items_of_total', '{n} of {total} items', { n: summary.count, total: total as number }),
        title: t(
            'mobile.flow.summary.truncated_hint',
            'This step returned the first {n} of {total} matches — raise its result limit to work through more.',
            { n: summary.count, total: total as number },
        ),
    };
}

function summariseObject(value: Record<string, unknown>): DataSummary | null {
    const found = envelopeList(value);
    if (found) {
        const summary = fromArray(found.list);
        return found.conventional ? withTotal(summary, value.total) : summary;
    }
    if (Object.keys(value).length === 0) return null;
    return { count: 1, kind: 'record', label: recordsLabel(1) };
}

/** Null when there is nothing worth reporting (no run yet, empty text). */
export function summariseData(value: unknown): DataSummary | null {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return fromArray(value);
    if (isObj(value)) return summariseObject(value);
    if (typeof value === 'string') {
        if (!value.length) return null;
        return {
            count: value.length,
            kind: 'text',
            label: value.length > LONG_TEXT
                ? t('mobile.flow.summary.long_text', 'text · {n} characters', { n: value.length })
                : t('automations.kind.text', 'text'),
        };
    }
    return { count: 1, kind: 'value', label: t('mobile.flow.summary.one_value', '1 value') };
}
