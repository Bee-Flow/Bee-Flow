/**
 * The builder's memory of its last test run (dry run), across turns.
 *
 * A dry run tells the model, per step, what the step really returned: the
 * `_hint` builder_request_dry_run puts on every step row (builderTools.js
 * dryRunHint: the output's type, its top-level keys and a one-line shape in
 * the run's path grammar). Keys and types, never values. The history the next
 * turn replays is user/assistant text only, so without this record that
 * knowledge is gone one message later and the model re-guesses paths a run
 * has already shown.
 *
 * At the end of a turn (routes/ai/automationBuilder/turnClosing.js) the hints
 * of the turn's last dry run are merged into the builder session snapshot as
 * `lastDryRunHints: { [stepId]: DryRunHint }`; the next turn renders them as
 * the "## Last test run" block of the late dynamic message
 * (routes/ai/automationBuilder/turnMessages.js), never into the cached
 * system prompt.
 *
 * Bounded: each field is cut to a fixed length, steps that are no longer in
 * the draft are dropped, and the whole record stays under
 * LAST_TEST_RUN_MAX_BYTES by dropping the OLDEST entries first (a merge puts
 * the newest run's steps last).
 *
 * Pure.
 */

/** The per-step hint as stored: dryRunHint's fields plus the row's status and step type. */
export type DryRunHint = {
    outputType?: string;
    /** Only when there is no `shape` line (the shape already names every top key). */
    topKeys?: string[];
    shape?: string;
    note?: string;
    status?: string;
    stepType?: string;
};
export type DryRunHints = Record<string, DryRunHint>;

/** The serialised record never grows past this (JSON bytes). */
export const LAST_TEST_RUN_MAX_BYTES = 4096;
const MAX_ID = 120;
const MAX_WORD = 40;
const MAX_SHAPE = 600;
const MAX_NOTE = 240;
const MAX_KEYS = 30;
const MAX_KEY = 80;

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function cut(v: unknown, max: number): string | undefined {
    if (typeof v !== 'string') return undefined;
    const s = v.replace(/\s+/g, ' ').trim();
    if (!s) return undefined;
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** One hint with only the known fields, each cut to its length; null when nothing is left. */
export function normaliseHint(raw: unknown): DryRunHint | null {
    if (!isPlainObject(raw)) return null;
    const out: DryRunHint = {};
    const outputType = cut(raw.outputType, MAX_WORD);
    if (outputType) out.outputType = outputType;
    const shape = cut(raw.shape, MAX_SHAPE);
    if (shape) out.shape = shape;
    else if (Array.isArray(raw.topKeys)) {
        const keys = raw.topKeys.map((k) => cut(k, MAX_KEY)).filter((k): k is string => !!k).slice(0, MAX_KEYS);
        if (keys.length) out.topKeys = keys;
    }
    const note = cut(raw.note, MAX_NOTE);
    if (note) out.note = note;
    const status = cut(raw.status, MAX_WORD);
    if (status) out.status = status;
    const stepType = cut(raw.stepType, MAX_WORD);
    if (stepType) out.stepType = stepType;
    return Object.keys(out).length ? out : null;
}

/**
 * The per-step hints of one dry-run result: the full tool result or its
 * compact model copy (builderTools/modelPayload.js compactDryRunForModel),
 * both `{ steps: [{ stepId, stepType, status, _hint }] }`. A step that ran
 * more than once (a loop body) keeps its first row that carries a shape.
 */
export function hintsFromDryRun(result: unknown): DryRunHints {
    const out: DryRunHints = {};
    const steps = isPlainObject(result) && Array.isArray(result.steps) ? result.steps : [];
    for (const row of steps) {
        if (!isPlainObject(row)) continue;
        const id = cut(row.stepId, MAX_ID);
        if (!id) continue;
        const hint = normaliseHint({ ...(isPlainObject(row._hint) ? row._hint : {}), status: row.status, stepType: row.stepType });
        if (!hint) continue;
        const had = out[id];
        if (had && (had.shape || !hint.shape)) continue;
        out[id] = hint;
    }
    return out;
}

/** Every step id of a definition: triggers, steps, loop bodies, flowlets. */
export function stepIdsOf(def: unknown): Set<string> {
    const ids = new Set<string>();
    const walk = (node: unknown, depth: number): void => {
        if (depth > 8 || !isPlainObject(node)) return;
        if (typeof node.id === 'string') ids.add(node.id);
        walk(node.trigger, depth + 1);
        for (const key of ['triggers', 'steps', 'body']) {
            const list = node[key];
            if (Array.isArray(list)) for (const s of list) walk(s, depth + 1);
        }
        if (isPlainObject(node.layers)) for (const layer of Object.values(node.layers)) walk(layer, depth + 1);
    };
    walk(def, 0);
    return ids;
}

/**
 * The stored record after a turn: the earlier hints first (oldest), then this
 * turn's run (newest, replacing an older hint of the same step), only steps
 * `keep` still holds when given, and the oldest entries dropped until the
 * record fits LAST_TEST_RUN_MAX_BYTES.
 */
export function mergeDryRunHints(prior: unknown, fresh: unknown, { keep = null, maxBytes = LAST_TEST_RUN_MAX_BYTES }: { keep?: Set<string> | null; maxBytes?: number } = {}): DryRunHints {
    const entries: Array<[string, DryRunHint]> = [];
    const add = (rec: unknown): void => {
        if (!isPlainObject(rec)) return;
        for (const [rawId, raw] of Object.entries(rec)) {
            const id = cut(rawId, MAX_ID);
            const hint = normaliseHint(raw);
            if (!id || !hint || (keep && !keep.has(id))) continue;
            const at = entries.findIndex(([k]) => k === id);
            if (at >= 0) entries.splice(at, 1);
            entries.push([id, hint]);
        }
    };
    add(prior);
    add(fresh);
    while (entries.length && JSON.stringify(Object.fromEntries(entries)).length > maxBytes) entries.shift();
    return Object.fromEntries(entries);
}

function statusWords(status: string | undefined): string {
    if (!status) return 'ran';
    if (/fail|error/i.test(status)) return 'failed';
    if (status === 'success' || status === 'done' || status === 'completed') return 'worked';
    if (status === 'skipped') return 'was skipped';
    return `ended ${status}`;
}

function outputWords(id: string, h: DryRunHint): string {
    const at = `steps.${id}.output`;
    if (h.shape) return `${at} is ${h.shape}`;
    if (h.topKeys?.length) return `${at} has ${h.topKeys.join(', ')}`;
    if (h.outputType === 'null') return 'it returned nothing';
    if (h.outputType) return `${at} is a ${h.outputType}`;
    return 'no output was recorded';
}

/**
 * The "## Last test run" block for the late dynamic message: one line per
 * step in plain words, or '' when there is nothing (left) to say. `keep`
 * (the step ids of the draft on screen) drops hints of steps removed since.
 */
export function renderLastTestRun(hints: unknown, { keep = null }: { keep?: Set<string> | null } = {}): string {
    const record = mergeDryRunHints(hints, null, { keep });
    const ids = Object.keys(record);
    if (!ids.length) return '';
    const lines = ids.map((id) => {
        const h = record[id];
        const type = h.stepType ? ` (${h.stepType})` : '';
        return `- \`${id}\`${type} ${statusWords(h.status)}; ${outputWords(id, h)}${h.note ? ` — ${h.note}` : ''}`;
    });
    return [
        '## Last test run',
        'What each step returned the last time the draft was tested (names and types only, no values). Bind to these paths instead of guessing; after you change a step, test again before you rely on its line.',
        ...lines,
    ].join('\n');
}
