/**
 * The declared-parameter rows of a flowlet's inputs, an agent tool and a
 * Studio App trigger — the pure half of the web's shared field designer
 * (agent-hub `Builder/flow/settings/fieldDesigner.jsx`).
 *
 * A declared field's `name` is a BINDING (`trigger.output.<name>`), so it is
 * only ever COMMITTED on purpose, validated first (a name the server accepts,
 * not a sibling's), carried through the routine when the host can, and the
 * author is told what moved — or that nothing could be carried.
 * Pinned by params.lockstep.test.ts.
 */

import { msg, type Msg, type OptionSpec } from '../declarative/spec';
import { fieldNameTaken, isValidFieldName } from '../shared/renameField';

export interface ParamRow {
    name?: string;
    type?: string;
    required?: boolean;
    description?: string;
    [key: string]: unknown;
}

const own = (value: string): OptionSpec => ({ value, label: value });

/** What a flowlet or an agent tool takes: JSON. */
export const CONTRACT_TYPES: readonly OptionSpec[] = ['string', 'number', 'boolean', 'object', 'array'].map(own);

/** What a Studio App action hands over — a FILE as well. The server's order (appTriggerContract.js). */
export const APP_TRIGGER_TYPES: readonly OptionSpec[] = [
    { value: 'string', label: msg('mobile.flow.params.type_text', 'text') },
    { value: 'number', label: msg('mobile.flow.params.type_number', 'number') },
    { value: 'boolean', label: msg('mobile.flow.params.type_boolean', 'boolean') },
    { value: 'array', label: msg('mobile.flow.params.type_array', 'array') },
    { value: 'object', label: msg('mobile.flow.params.type_json', 'json') },
    { value: 'file', label: msg('mobile.flow.params.type_file', 'file (pdf / word / excel / image)') },
];

/** Names a designer mints for a row nobody named yet; renaming one carries no bindings. */
export const PLACEHOLDER_NAME_RE = /^(?:input|arg)\d+$/;

/** What is wrong with a name that is ALREADY stored, or null. */
export function nameProblem(name: unknown): Msg | null {
    if (!name) return null;
    if (!/^[A-Za-z]/.test(String(name))) return msg('mobile.flow.params.name_letter_first', 'Names must start with a letter (no leading _ or digit).');
    if (!isValidFieldName(name)) return msg('mobile.flow.params.name_charset', 'Letters, digits and underscores only.');
    return null;
}

/** A new row, named by counting up past every name in use (never off the length). */
export function addParam(rows: readonly ParamRow[], prefix: string, defaults: Partial<ParamRow> | null = null): ParamRow[] {
    let n = rows.length + 1;
    while (rows.some((r) => r?.name === `${prefix}${n}`)) n += 1;
    return [...rows, { name: `${prefix}${n}`, type: 'string', required: false, ...(defaults || {}) }];
}

export interface RenameResult {
    ok: boolean;
    unchanged: boolean;
    name: string;
    error: Msg | null;
    note: Msg | null;
}

/**
 * THE rename path: validates, refuses, carries, and words the outcome. Never
 * writes: the caller stores `name` only when `ok`. `carry` rewrites the whole
 * routine and answers how many bindings moved; absent where the editor cannot
 * see the steps that bind the name.
 */
export function applyBindingRename({
    from,
    to,
    siblings = [],
    carry = null,
    takenError,
    orphanNote = false,
}: {
    from: string;
    to: unknown;
    siblings?: readonly unknown[];
    carry?: ((from: string, to: string) => number | undefined) | null;
    takenError: Msg;
    orphanNote?: boolean;
}): RenameResult {
    const next = String(to ?? '').trim();
    if (next === from) return { ok: false, unchanged: true, name: from, error: null, note: null };
    if (!isValidFieldName(next)) {
        return { ok: false, unchanged: false, name: from, error: msg('mobile.flow.params.name_invalid', 'Start with a letter; letters, digits and underscores only.'), note: null };
    }
    if (fieldNameTaken(siblings, next, from)) return { ok: false, unchanged: false, name: from, error: takenError, note: null };
    const moved = typeof carry === 'function' ? carry(from, next) : undefined;
    return { ok: true, unchanged: false, name: next, error: null, note: renameNote(moved, from, orphanNote) };
}

function renameNote(moved: number | undefined, from: string, orphanNote: boolean): Msg | null {
    if (typeof moved === 'number') {
        if (moved === 0) return msg('mobile.flow.params.renamed_none', 'Renamed. Nothing was pointing at it yet.');
        return moved === 1
            ? msg('mobile.flow.params.renamed_one', 'Renamed — 1 binding in this routine now points at it.')
            : msg('mobile.flow.params.renamed_many', 'Renamed — {n} bindings in this routine now point at it.', { n: moved });
    }
    return orphanNote ? msg('mobile.flow.params.renamed_here_only', 'Renamed here only — steps that bind “{name}” still point at the old name.', { name: from }) : null;
}
