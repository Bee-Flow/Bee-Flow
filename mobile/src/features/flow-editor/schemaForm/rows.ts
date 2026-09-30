/**
 * The row edits of the schema-driven inputs form, as pure functions over the
 * `{ [key]: binding }` map — the state-changing half of agent-hub
 * `Builder/mapping/ToolInputForm.jsx` (updateField, renameField, removeField,
 * addField, the pending rows, "Add field from a previous step", and the field
 * NAME commit). Pinned by schemaForm.lockstep.test.ts.
 */

import { translate as t } from '@/core/i18n';

import { suggestKeyFromPath } from '../bindings/bindingHelpers';
import { isEmptyBinding } from '../bindings/partitionInputs';
import type { Binding, BindingValue } from '../bindings/types';

/** A step's `inputs` map: bindings, or bare literals (bind.js passes those through). */
export type Inputs = Record<string, unknown>;

const EMPTY: Binding = { kind: 'literal', value: '' };

/**
 * Set one field. An emptied tool PARAM is deleted (omitted from the call);
 * with `keepEmptyFields` (Set / layer output: the user's own named fields) it
 * stays, as an empty literal.
 */
export function updateInput(inputs: Inputs | null | undefined, key: string, binding: BindingValue, keepEmptyFields = false): Inputs {
    const next = { ...(inputs || {}) };
    if (isEmptyBinding(binding) && !keepEmptyFields) delete next[key];
    else next[key] = binding || { ...EMPTY };
    return next;
}

/** Rename a key in place, keeping the map's order; a blank or unchanged name is a no-op (null). */
export function renameInput(inputs: Inputs | null | undefined, oldKey: string, newKey: unknown): Inputs | null {
    const cleaned = String(newKey || '').trim();
    if (!cleaned || cleaned === oldKey) return null;
    const next: Inputs = {};
    for (const [k, v] of Object.entries(inputs || {})) next[k === oldKey ? cleaned : k] = v;
    return next;
}

export function removeInput(inputs: Inputs | null | undefined, key: string): Inputs {
    const next = { ...(inputs || {}) };
    delete next[key];
    return next;
}

/** `base`, `base2`, `base3`, … — the first not in `taken`. */
export function uniqueKey(taken: Iterable<string>, base = 'field'): string {
    const used = new Set(taken);
    let k = base;
    let n = 1;
    while (used.has(k)) k = `${base}${++n}`;
    return k;
}

export interface PendingRow {
    id: number;
    key: string;
    binding: BindingValue;
}

/**
 * "Add field". Named fields that may be empty land in the map at once (and
 * the new name is the one to focus); tool params are held as a PENDING row
 * until they have a name and a value, or the autosave's empty-strip would make
 * them flash and vanish.
 */
export function addInputField(
    inputs: Inputs | null | undefined,
    { keepEmptyFields = false, pending = [], nextId = 1 }: { keepEmptyFields?: boolean; pending?: readonly PendingRow[]; nextId?: number } = {},
): { inputs: Inputs; focusKey: string } | { pending: PendingRow } {
    const key = uniqueKey([...Object.keys(inputs || {}), ...pending.map((p) => p.key)]);
    if (keepEmptyFields) return { inputs: { ...(inputs || {}), [key]: { ...EMPTY } }, focusKey: key };
    return { pending: { id: nextId, key, binding: { ...EMPTY } } };
}

/** A pending row joins the map once it has a key and a value (a taken key gets a suffix); null = keep editing. */
export function commitPendingRow(inputs: Inputs | null | undefined, row: PendingRow | null | undefined): Inputs | null {
    const key = String(row?.key || '').trim();
    if (!row || !key || isEmptyBinding(row.binding)) return null;
    let finalKey = key;
    let n = 1;
    const taken = new Set(Object.keys(inputs || {}));
    while (taken.has(finalKey)) finalKey = `${key}${++n}`;
    return { ...(inputs || {}), [finalKey]: row.binding };
}

/** "Add field from a previous step": a named ref field, the name from the path's last segment. */
export function addFieldFromPath(inputs: Inputs | null | undefined, path: unknown, pending: readonly PendingRow[] = []): { inputs: Inputs; key: string } {
    const key = uniqueKey([...Object.keys(inputs || {}), ...pending.map((p) => p.key)], suggestKeyFromPath(path));
    return { inputs: { ...(inputs || {}), [key]: { kind: 'ref', path: String(path || '').trim() } }, key };
}

/**
 * A path dropped or typed into a row's NAME: the name becomes its last
 * segment and — only while the row's value is still empty — the value binds
 * to the path. A configured binding is never clobbered.
 */
export function adoptPathIntoRow(inputs: Inputs | null | undefined, rowKey: string, path: string, suggested: string): Inputs {
    const current = inputs || {};
    const nextKey = suggested && !Object.prototype.hasOwnProperty.call(current, suggested) ? suggested : `${suggested || 'field'}_2`;
    const next: Inputs = {};
    for (const [k, v] of Object.entries(current)) {
        if (k === rowKey) next[nextKey] = isEmptyBinding(current[rowKey]) ? { kind: 'ref', path } : v;
        else next[k] = v;
    }
    return next;
}

// Names JS never assigns as own keys — a field so named vanishes from the output.
export const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Does this look like a binding path rather than a field name? */
export const looksLikePath = (s: string): boolean => /[.\s[\]]/.test(s);

export type NameCommit =
    | { action: 'keep' }
    | { action: 'revert' }
    | { action: 'adopt'; path: string; suggested: string }
    | { action: 'reserved'; name: string }
    | { action: 'duplicate'; name: string }
    | { action: 'rename'; name: string };

/**
 * A field NAME being committed (on blur / Enter — never per keystroke). A
 * pasted path keeps its meaningful tail, or — rooted in the run's data, with
 * `canAdopt` — becomes the row's binding.
 */
export function commitFieldName(raw: unknown, { fieldKey, siblingKeys = [], canAdopt = false }: { fieldKey: string; siblingKeys?: readonly string[]; canAdopt?: boolean }): NameCommit {
    let cleaned = String(raw ?? '').trim();
    if (cleaned === fieldKey) return { action: 'keep' };
    if (!cleaned) return { action: 'revert' };
    if (looksLikePath(cleaned)) {
        const suggested = suggestKeyFromPath(cleaned);
        if (canAdopt && /^(trigger|steps|vars|secrets|loop)[.[]/.test(cleaned)) return { action: 'adopt', path: cleaned, suggested };
        cleaned = suggested;
    }
    if (RESERVED_FIELD_NAMES.has(cleaned)) return { action: 'reserved', name: cleaned };
    if (siblingKeys.includes(cleaned)) return { action: 'duplicate', name: cleaned };
    return cleaned === fieldKey ? { action: 'keep' } : { action: 'rename', name: cleaned };
}

/** The sentence under a name box after a commit, or null. */
export function nameCommitMessage(result: NameCommit): string | null {
    if (result.action === 'revert') return t('mobile.flow.field_name.required', 'Name required — reverted.');
    if (result.action === 'reserved') return t('mobile.flow.field_name.reserved', '“{name}” is a reserved name.', { name: result.name });
    if (result.action === 'duplicate') return t('mobile.flow.field_name.duplicate', 'A field named “{name}” already exists.', { name: result.name });
    return null;
}
