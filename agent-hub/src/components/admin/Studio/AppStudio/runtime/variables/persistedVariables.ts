/**
 * The variables a signed-in viewer keeps across a reload (schema 3, `persist`), in the
 * browser's own storage: sessionStorage for "session", localStorage for "local". One entry
 * per app and viewer (the key the run page builds, never one for an anonymous visitor or the
 * editor), holding only the declared kept variables, at most MAX_PERSISTED_VARIABLE_BYTES for
 * all of them together. Nothing here is sent anywhere.
 *
 * Storage can be missing, full or refused (a private window, blocked site data): every access
 * is wrapped, and the run then starts from the declared defaults.
 */
import { coerceVariableDefault } from '../appVariables';
import { MAX_PERSISTED_VARIABLE_BYTES, persistedVariables } from '@shared/appDefinition/variableScopes.mjs';

type Mode = 'session' | 'local';
type Vars = Record<string, unknown>;

const PREFIX = 'bfa.vars.';

/**
 * The key of one signed-in viewer of one app (a draft run keeps its own), or null: no app,
 * or no signed-in viewer (an anonymous visitor of a public page carries no id).
 */
export function persistKeyFor(appId: string | null | undefined, viewer: unknown, draft: boolean): string | null {
    const id = viewer && typeof viewer === 'object' ? (viewer as { id?: unknown }).id : null;
    if (!appId || (typeof id !== 'string' && typeof id !== 'number') || id === '') return null;
    return `${appId}.${String(id)}${draft ? '.draft' : ''}`;
}

function storageOf(mode: Mode): Storage | null {
    try {
        return mode === 'local' ? window.localStorage : window.sessionStorage;
    } catch {
        return null;
    }
}

function readEntry(mode: Mode, key: string): Vars {
    try {
        const text = storageOf(mode)?.getItem(PREFIX + key);
        const parsed: unknown = text ? JSON.parse(text) : null;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Vars : {};
    } catch {
        return {};
    }
}

/**
 * The kept values of `variables` for `key`: only declared kept names, only values that
 * already have the declared type (anything else is left to the default).
 */
export function readPersistedVariables(key: string | null | undefined, variables: unknown): Vars {
    if (!key) return {};
    const kept = persistedVariables(variables);
    if (!kept.length) return {};
    const out: Vars = {};
    const entries: Partial<Record<Mode, Vars>> = {};
    for (const { name, type, persist } of kept) {
        const entry = entries[persist] ?? (entries[persist] = readEntry(persist, key));
        if (!Object.hasOwn(entry, name)) continue;
        const { coerced } = coerceVariableDefault(type, entry[name]);
        if (!coerced) out[name] = entry[name];
    }
    return out;
}

function byteLength(text: string): number {
    return new TextEncoder().encode(text).length;
}

/**
 * Write the kept values of `vars` for `key`. A value that would take the app past the byte
 * ceiling is left out (the ones declared first are kept first); an entry with nothing in it
 * is removed.
 */
export function writePersistedVariables(key: string | null | undefined, variables: unknown, vars: Vars): void {
    if (!key) return;
    const kept = persistedVariables(variables);
    if (!kept.length) return;
    const entries: Record<Mode, Vars> = { session: {}, local: {} };
    let used = 2; // {}
    for (const { name, persist } of kept) {
        if (!Object.hasOwn(vars, name) || vars[name] === undefined) continue;
        let size: number;
        try { size = byteLength(JSON.stringify({ [name]: vars[name] })); } catch { continue; }
        if (used + size > MAX_PERSISTED_VARIABLE_BYTES) continue;
        used += size;
        entries[persist][name] = vars[name];
    }
    for (const mode of ['session', 'local'] as const) writeEntry(storageOf(mode), key, entries[mode]);
}

/** False when the storage is missing, full or refused: the values are then simply not kept. */
function writeEntry(store: Storage | null, key: string, entry: Vars): boolean {
    if (!store) return false;
    try {
        if (Object.keys(entry).length) store.setItem(PREFIX + key, JSON.stringify(entry));
        else store.removeItem(PREFIX + key);
        return true;
    } catch {
        return false;
    }
}
