/**
 * App Studio compatibility corpus: what today's code does with one stored app, per concern.
 *
 * Every function here calls the product's own module for its concern and reduces the answer
 * to something a frozen file can hold and a failing test can explain:
 *
 *   canonicalSection   canonicalizeAppDefinition: the exact bytes (sha256 + length), whether a
 *                      second pass changes them, and a hash per top-level key, screen and action
 *                      so a failure names the part that moved
 *   schemaSection      schemaVersion as stored and after canonicalize
 *   validationSection  validateAppDefinition on the canonical form: "code @ path" per error and
 *                      warning, strict (publish-style data references) and as a save runs it
 *   installSection     templateUpgrade.hashDefinition of the stored and of the re-saved form
 *                      (template installs only: the only rows that carry an install hash)
 *   publicSection      publicAccess.buildPublicDefinition over the stored bytes, as the public
 *                      page route serves them (apps with publicAccess only)
 *   ordinalSection     actionSequence.flattenSteps per action: "<ordinal> <kind>", stored and
 *                      canonical
 *
 * The compiled SQL of the read descriptors is async and lives in readSql.mts.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { isObject } from './corpus.mts';
import type { CorpusEntry, Obj } from './corpus.mts';

const nodeRequire = createRequire(import.meta.url);

type Finding = { code: string; path: string };
type Canon = (def: unknown) => { def: Obj; repairs: Finding[] };
type Validate = (def: unknown, opts?: Obj) => { errors: Finding[]; warnings: Finding[] };
type Surface = { ok: boolean; reason?: string; actionIds?: Set<string> };

const { canonicalizeAppDefinition } = nodeRequire('../canonicalize') as { canonicalizeAppDefinition: Canon };
const { validateAppDefinition } = nodeRequire('../validate') as { validateAppDefinition: Validate };
const { hashDefinition } = nodeRequire('../templateUpgrade') as { hashDefinition: (def: unknown) => string };
const publicAccess = nodeRequire('../publicAccess') as {
    resolvePublicSurface: (def: unknown) => Surface;
    buildPublicDefinition: (def: unknown, surface: Surface) => Obj;
};
const actionSequence = nodeRequire('../actionSequence') as {
    normalizeSequence: (action: unknown) => unknown[];
    flattenSteps: (steps: unknown[]) => Obj[];
};

export function sha256(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Short hash of one part of a definition: enough to say WHICH part moved. */
function partHash(value: unknown): string {
    return sha256(JSON.stringify(value) ?? 'undefined').slice(0, 16);
}

export function canonicalOf(definition: unknown): Obj {
    return canonicalizeAppDefinition(definition).def;
}

/** The parts of a definition, keyed so a failure message can name them. */
export function definitionParts(def: Obj): Record<string, string> {
    const parts: Record<string, string> = {};
    for (const [key, value] of Object.entries(def)) {
        if (key === 'screens' && Array.isArray(value)) {
            value.forEach((screen, i) => { parts[`screens[${i}] ${isObject(screen) ? String(screen.id) : '?'}`] = partHash(screen); });
        } else if (key === 'actions' && isObject(value)) {
            for (const [id, action] of Object.entries(value)) parts[`actions.${id}`] = partHash(action);
        } else {
            parts[key] = partHash(value);
        }
    }
    return parts;
}

/** Every id a definition carries: `id` members anywhere, and the keys of `actions`. */
function collectIds(value: unknown, out: string[]): string[] {
    if (Array.isArray(value)) {
        for (const v of value) collectIds(v, out);
    } else if (isObject(value)) {
        if (typeof value.id === 'string' && !out.includes(value.id)) out.push(value.id);
        for (const v of Object.values(value)) collectIds(v, out);
    }
    return out;
}

/**
 * Canonicalize replaces a missing or invalid id with a RANDOM one (newId), so the bytes of
 * such an input differ per run. An id the canonical form has and the input never mentions is
 * one of those; each is replaced by `<generated-N>` (first-seen order) wherever it occurs.
 */
export function maskGeneratedIds(input: unknown, canonical: Obj): { text: string; generated: number } {
    const inputText = JSON.stringify(input) ?? '';
    let text = JSON.stringify(canonical);
    const ids = collectIds(canonical, isObject(canonical.actions) ? Object.keys(canonical.actions) : []);
    let generated = 0;
    for (const id of ids) {
        const quoted = JSON.stringify(id);
        if (inputText.includes(quoted)) continue;
        generated += 1;
        text = text.split(quoted).join(JSON.stringify(`<generated-${generated}>`));
    }
    return { text, generated };
}

export function canonicalSection(entry: CorpusEntry): Obj {
    const canonical = canonicalOf(entry.definition);
    const raw = JSON.stringify(canonical);
    const { text, generated } = maskGeneratedIds(entry.definition, canonical);
    const again = JSON.stringify(canonicalOf(canonical));
    return {
        sha256: sha256(text),
        bytes: Buffer.byteLength(text, 'utf8'),
        ...(generated ? { generatedIds: generated } : {}),
        inputIsCanonical: JSON.stringify(entry.definition) === raw,
        idempotent: again === raw,
        ...(again === raw ? {} : { secondPassSha256: sha256(again) }),
        keys: Object.keys(canonical),
        parts: definitionParts(JSON.parse(text) as Obj),
    };
}

export function schemaSection(entry: CorpusEntry): Obj {
    const stored = isObject(entry.definition) ? entry.definition.schemaVersion : undefined;
    return { stored: stored ?? null, canonical: canonicalOf(entry.definition).schemaVersion ?? null };
}

function findingList(list: Finding[]): string[] {
    return list.map((f) => `${f.code} @ ${f.path}`).sort();
}

/** Validator options as templates.test.js passes them: the app's own model and dataset ids. */
function dataOpts(entry: CorpusEntry): Obj {
    if (!entry.dataModel) return {};
    const datasets = (entry.datasets ?? []).map((d) => d.id).filter((id) => typeof id === 'string');
    return { dataModel: entry.dataModel, datasets };
}

export function validationSection(entry: CorpusEntry): Obj {
    const canonical = canonicalOf(entry.definition);
    const strict = validateAppDefinition(canonical, dataOpts(entry));
    const save = validateAppDefinition(canonical, { ...dataOpts(entry), dataRefsAsWarnings: true });
    return {
        strict: { errors: findingList(strict.errors), warnings: findingList(strict.warnings) },
        save: { errors: findingList(save.errors), warnings: findingList(save.warnings) },
    };
}

/** Only template installs carry a hash (routes/studioApps/crud.js create-from-template). */
export function installSection(entry: CorpusEntry): Obj | null {
    if (typeof entry.about.templateId !== 'string') return null;
    return {
        stored: hashDefinition(entry.definition),
        afterResave: hashDefinition(canonicalOf(entry.definition)),
    };
}

/** The anonymous visitor's definition, built from the stored bytes as the public route does. */
export function publicSection(entry: CorpusEntry): Obj | null {
    const def = entry.definition;
    if (!isObject(def) || !isObject(def.publicAccess)) return null;
    const surface = publicAccess.resolvePublicSurface(def);
    if (!surface.ok) return { refused: surface.reason ?? 'unknown' };
    const value = publicAccess.buildPublicDefinition(def, surface);
    return {
        actionIds: [...(surface.actionIds ?? [])].sort(),
        sha256: sha256(JSON.stringify(value)),
        definition: value,
    };
}

function ordinalsOf(def: unknown): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    const actions = isObject(def) && isObject(def.actions) ? def.actions : {};
    for (const [id, action] of Object.entries(actions)) {
        const flat = actionSequence.flattenSteps(actionSequence.normalizeSequence(action));
        out[id] = flat.map((step, i) => `${i} ${String(step.kind)}`);
    }
    return out;
}

export function ordinalSection(entry: CorpusEntry): Obj {
    const stored = ordinalsOf(entry.definition);
    const canonical = ordinalsOf(canonicalOf(entry.definition));
    const same = JSON.stringify(stored) === JSON.stringify(canonical);
    return { stored, canonical: same ? 'same as stored' : canonical };
}

/** Every synchronous section, in the order a frozen file lists them. */
export function syncSections(entry: CorpusEntry): Obj {
    const out: Obj = {
        canonical: canonicalSection(entry),
        schemaVersion: schemaSection(entry),
        validation: validationSection(entry),
        ordinals: ordinalSection(entry),
    };
    const install = installSection(entry);
    if (install) out.installHash = install;
    const pub = publicSection(entry);
    if (pub) out.publicDefinition = pub;
    return out;
}
