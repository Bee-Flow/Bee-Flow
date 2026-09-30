/**
 * The Edit-data card's summary line — a port of `describeSetOperation` and
 * `summariseSetStep` from the web builder's flow/setOperations.js, pinned by
 * setSummary.lockstep.test.ts (differential: both run on the same steps).
 */

import { humanizeFieldKey } from '@/features/flow-editor/model';

type Op = Record<string, unknown>;

const col = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0;
const keysOf = (o: Op) => (Array.isArray(o.keys) ? (o.keys as unknown[]) : []).filter(col);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const DESCRIBE: Record<string, (o: Op) => string> = {
    rowId: (o) => (col(o.target) ? `number rows → ${humanizeFieldKey(o.target)}` : 'number rows'),
    groupId: (o) => {
        const keys = keysOf(o).map((k) => humanizeFieldKey(k));
        return keys.length ? `shared ID by ${keys.join(' + ')}` : 'shared ID';
    },
    rename: (o) => (col(o.from) && col(o.to) ? `rename ${humanizeFieldKey(o.from)} → ${humanizeFieldKey(o.to)}` : 'rename a field'),
    keep: (o) => (keysOf(o).length ? `keep ${plural(keysOf(o).length, 'field')}` : 'keep fields'),
    remove: (o) => (keysOf(o).length ? `remove ${plural(keysOf(o).length, 'field')}` : 'remove fields'),
    sort: (o) => (col(o.key) ? `sort by ${humanizeFieldKey(o.key)}${o.direction === 'desc' ? ' (high → low)' : ''}` : 'sort rows'),
};

/** One friendly line per list operation. */
export function describeSetOperation(o: unknown): string {
    if (!o || typeof o !== 'object') return '';
    const op = (o as Op).op;
    const fn = typeof op === 'string' && Object.prototype.hasOwnProperty.call(DESCRIBE, op) ? DESCRIBE[op] : undefined;
    return fn ? fn(o as Op) : '';
}

/**
 * "3 fields: Name, Email, Phone" for one record; "Each row: +2 fields ·
 * number rows · shared ID by Subject" when it works through a list.
 */
export function summariseSetStep(step: Record<string, unknown> | null | undefined): string {
    if (!step) return '';
    const fieldKeys = Object.keys((step.fields as object) || {});
    if (typeof step.arrayRef !== 'string') {
        if (fieldKeys.length === 0) return 'No fields yet';
        const shown = fieldKeys.slice(0, 4).map((k) => humanizeFieldKey(k)).join(', ');
        return `${plural(fieldKeys.length, 'field')}: ${shown}${fieldKeys.length > 4 ? '…' : ''}`;
    }
    const parts: string[] = [];
    if (fieldKeys.length) parts.push(`+${plural(fieldKeys.length, 'field')}`);
    const ops = (Array.isArray(step.operations) ? step.operations : []).map(describeSetOperation).filter(Boolean);
    parts.push(...ops.slice(0, 2));
    if (ops.length > 2) parts.push(`+${ops.length - 2} more`);
    if (!parts.length) return 'Nothing to do yet';
    return `Each row: ${parts.join(' · ')}`;
}
