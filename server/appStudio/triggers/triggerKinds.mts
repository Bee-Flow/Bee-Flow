/**
 * App Studio server triggers: the registry of trigger KINDS.
 *
 * A trigger (`definition.triggers[]`, schema 3) starts one action of the app on the server with
 * nobody at the page. Every trigger has the same envelope
 *
 *   { id, kind, actionId, enabled?, …the fields of its kind }
 *
 * and a kind is ONE file, `triggers/kinds/<kind>.mts`, found by a sorted directory read. `schedule`
 * is the first; a kind that fires on something else than time (a changed record, a call from
 * outside) is a second file and no edit here. The file's default export is a TriggerKind:
 *
 *   kind         its own file name
 *   since        the schema version that introduced it (3 or later)
 *   fields       the names of its own fields on a trigger (the envelope's are not listed)
 *   canon        (raw, at, push) => its fields in canonical form, or null when the trigger cannot
 *                be kept (the reason was pushed)
 *   validate     (trigger, at, ctx) => findings for a trigger that skipped the canonicalizer
 *   config       (trigger) => what the armed row keeps of the trigger (and what its fingerprint covers)
 *   nextFireAt   (config, afterMs) => the next moment it fires by itself, in epoch ms; null when it
 *                never does (a kind that fires on an event leaves the function out)
 *   refusedKinds step kinds this kind of trigger may not run although the catalogue lets them run
 *                unattended (unattendedPolicy.mts); [] for none
 *   shape, description   catalogue text for the AI builder
 *
 * What every kind shares is not here: the arming (triggerSync.mts), the claim and the run
 * (triggerFire.mts), who the run is (unattendedIdentity.mts) and what it may do (unattendedPolicy.mts).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export type Obj = Record<string, unknown>;
export type Push = (code: string, path: string, message: string) => void;
export type Finding = { code: string; severity: string; path: string; message: string; hint: string };
export type KindValidateCtx = { pushE: (f: Finding) => void; pushW: (f: Finding) => void };

export type TriggerKind = {
    kind: string;
    since: number;
    fields: readonly string[];
    canon: (raw: Obj, at: string, push: Push) => Obj | null;
    validate: (trigger: Obj, at: string, ctx: KindValidateCtx) => void;
    config: (trigger: Obj) => Obj;
    nextFireAt?: (config: Obj, afterMs: number) => number | null;
    refusedKinds: readonly string[];
    shape: string;
    description: string;
};

const KINDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'kinds');
const nodeRequire = createRequire(import.meta.url);
const NAME_OK = 'abcdefghijklmnopqrstuvwxyz0123456789_';

/** A kind name: lower case letters, digits and underscores, starting with a letter, at most 40. */
export function isKindName(name: unknown): name is string {
    if (typeof name !== 'string' || !name || name.length > 40 || name[0] < 'a' || name[0] > 'z') return false;
    for (const ch of name) if (!NAME_OK.includes(ch)) return false;
    return true;
}

/** Throws on a malformed kind file: a broken registry must fail the boot, not drop a kind in silence. */
export function checkKind(entry: unknown, fileName: string | null = null): TriggerKind {
    const where = fileName ? `triggers/kinds/${fileName}.mts` : 'trigger kind';
    const e = entry as Partial<TriggerKind> | null;
    if (!e || typeof e !== 'object') throw new Error(`${where}: must export a trigger kind as its default`);
    const problems: string[] = [];
    if (!isKindName(e.kind)) problems.push('"kind" is a lower_snake_case name');
    else if (fileName !== null && e.kind !== fileName) problems.push(`"kind" (${e.kind}) equals the file name`);
    if (!Number.isInteger(e.since) || (e.since as number) < 3) problems.push('"since" is an integer of 3 or more');
    if (!Array.isArray(e.fields) || !e.fields.every((f) => typeof f === 'string' && f && !ENVELOPE_FIELDS.includes(f))) problems.push('"fields" lists its own field names (never id, kind, actionId or enabled)');
    for (const fn of ['canon', 'validate', 'config'] as const) if (typeof e[fn] !== 'function') problems.push(`"${fn}" is a function`);
    if (e.nextFireAt !== undefined && typeof e.nextFireAt !== 'function') problems.push('"nextFireAt" is a function when present');
    if (!Array.isArray(e.refusedKinds) || !e.refusedKinds.every((k) => typeof k === 'string')) problems.push('"refusedKinds" lists step kinds ([] for none)');
    if (typeof e.shape !== 'string' || !e.shape || typeof e.description !== 'string' || !e.description) problems.push('"shape" and "description" are catalogue text');
    if (problems.length) throw new Error(`${where}: ${problems.join('; ')}`);
    return e as TriggerKind;
}

/** The fields every trigger has, whatever its kind. */
export const ENVELOPE_FIELDS: readonly string[] = Object.freeze(['id', 'kind', 'actionId', 'enabled']);

/** Every `<kind>.mts` in `dir`, sorted by file name. */
export function loadTriggerKinds(dir: string = KINDS_DIR): TriggerKind[] {
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw e;
    }
    return names
        .filter((n) => n.endsWith('.mts') && !n.endsWith('.test.mts'))
        .sort()
        .map((n) => checkKind((nodeRequire(path.join(dir, n)) as { default?: unknown }).default, n.slice(0, -'.mts'.length)));
}

let entries: TriggerKind[] | null = null;

/** The registered kinds, in file-name order. */
export function triggerKinds(): readonly TriggerKind[] {
    if (!entries) entries = loadTriggerKinds();
    return entries;
}

/** The kind registered under `name`, or null. */
export function triggerKind(name: unknown): TriggerKind | null {
    return triggerKinds().find((k) => k.kind === name) ?? null;
}

/** Test-only: run `fn` with `list` as the registry. */
export async function _withTriggerKinds<T>(list: unknown[], fn: () => T | Promise<T>): Promise<T> {
    const before = entries;
    entries = list.map((e) => checkKind(e));
    try {
        return await fn();
    } finally {
        entries = before;
    }
}
