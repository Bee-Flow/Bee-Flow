/**
 * The engine line: the words the south bar adds to the right of the build
 * verb about the machine doing the reading and writing.
 *
 * Everything here is a MEASUREMENT the stream delivered, never a guess: which
 * model (`round_start`), whether it runs on this machine (`round_start.local`),
 * how far it is through the prompt (llama-server's `prompt_progress`), and
 * how fast the last round read and wrote (`usage.timings`). Where a number is
 * missing the segment is simply absent — the line shrinks rather than shows
 * an "undefined tok/s". Pure and untied to React so every wording can be
 * pinned in a table test; CanvasSouthBar only joins the pieces with " · ".
 *
 * Contract (scratchpad/viz-contract.md, "engine line"):
 *   engine  state.engine  { modelId, local, providerType, readTokPerSec, writeTokPerSec, … } | null
 *   turn    state.turn    { phase: 'reading' | 'writing' | null, progress: { total, cache, processed } | null, … } | null
 */

/**
 * `12.4k`-style token counts: under a thousand the number itself, above it
 * one decimal and a `k`. One decimal always — "28.0k" beside "12.4k" keeps
 * the two figures the same width, and the bar under them is what moves.
 * Anything that is not a non-negative finite number reads as 0, so no caller
 * can ever print NaN.
 */
export function formatK(n) {
    const v = Number.isFinite(n) && n > 0 ? n : 0;
    if (v < 1000) return String(Math.round(v));
    // Round to tenths of a thousand FIRST: `(1450 / 1000).toFixed(1)` is
    // "1.4" (the float is 1.4499…), and a rate of 1450 tok/s reading as
    // "1.4k" is the kind of small lie a measurement line must not tell.
    return `${(Math.round(v / 100) / 10).toFixed(1)}k`;
}

export const MODEL_NAME_MAX = 22;

/**
 * The model id as a short label: provider prefixes and paths stripped
 * (`local/qwen/qwen3.6-35b` → `qwen3.6-35b`), then cut to MODEL_NAME_MAX with
 * an ellipsis. The full id belongs in a `title`, not on the bar.
 */
export function shortModelName(modelId, max = MODEL_NAME_MAX) {
    const raw = String(modelId || '').trim();
    if (!raw) return null;
    const parts = raw.split('/').filter(Boolean);
    if (!parts.length) return null;
    const name = parts[parts.length - 1];
    return name.length > max ? `${name.slice(0, Math.max(1, max - 1)).trimEnd()}…` : name;
}

const positive = (n) => Number.isFinite(n) && n > 0;

/** llama-server prompt progress with a usable total, or null. */
function progressOf(turn) {
    const p = turn?.progress;
    if (!p || !positive(p.total)) return null;
    const total = p.total;
    const processed = Math.min(total, Math.max(0, Number(p.processed) || 0));
    const cache = Math.min(total, Math.max(0, Number(p.cache) || 0));
    return { total, processed, cache };
}

/**
 * The pill that opens the line — only ever the words "On this machine", and
 * only when the server SAID the round runs on a self-hosted runtime
 * (`local === true`). Null and false both mean "do not claim it".
 */
export function enginePill({ engine, t }) {
    if (engine?.local !== true) return null;
    return t('routines.canvas.engine.local', 'On this machine');
}

/** Who: the model's short name (when known) and, for a local model only, the privacy claim. */
function identitySegments(engine, t) {
    const out = [];
    const model = shortModelName(engine?.modelId);
    if (model) out.push(model);
    if (engine?.local === true) out.push(t('routines.canvas.engine.offline', 'nothing sent outside'));
    return out;
}

/** How far: the live reading figure, and the remembered share when there is one. */
function readingSegments(progress, t, fmt) {
    const out = [t('routines.canvas.engine.reading', 'reading {done} of {total} tokens', {
        done: fmt(progress.processed),
        total: fmt(progress.total),
    })];
    if (progress.cache > 0) out.push(t('routines.canvas.engine.remembered', '{n} remembered', { n: fmt(progress.cache) }));
    return out;
}

/** How fast: the last round's rates, each only when it was measured. */
function rateSegments(engine, t, fmt) {
    const out = [];
    if (positive(engine?.readTokPerSec)) out.push(t('routines.canvas.engine.reads', 'reads {n} tok/s', { n: fmt(engine.readTokPerSec) }));
    if (positive(engine?.writeTokPerSec)) out.push(t('routines.canvas.engine.writes', 'writes {n} tok/s', { n: fmt(engine.writeTokPerSec) }));
    return out;
}

/**
 * The text segments after the pill, in order. Never contains an empty
 * string, `undefined`, or a NaN — a missing measurement leaves no segment.
 *
 *   1. the model's short name (when known) and, for a local model only,
 *      "nothing sent outside";
 *   2. the live state: "reading X of Y tokens" (+ "N remembered") while the
 *      runtime reports prompt progress; "writing…" once tokens flow;
 *   3. the last round's rates — except while the live reading figure is up,
 *      when the stale rate would only compete with the real number.
 */
export function engineSegments({ engine, turn, t, formatK: fmt = formatK }) {
    const out = identitySegments(engine, t);
    const phase = turn?.phase || null;
    const progress = phase === 'reading' ? progressOf(turn) : null;
    if (progress) return out.concat(readingSegments(progress, t, fmt));
    if (phase === 'writing') out.push(t('routines.canvas.engine.writing', 'writing…'));
    return out.concat(rateSegments(engine, t, fmt));
}

/** True when the line would carry a last-round rate — what the "measured on the last call" title is for. */
export function showsRates({ engine, turn }) {
    const progress = turn?.phase === 'reading' ? progressOf(turn) : null;
    return !progress && (positive(engine?.readTokPerSec) || positive(engine?.writeTokPerSec));
}
