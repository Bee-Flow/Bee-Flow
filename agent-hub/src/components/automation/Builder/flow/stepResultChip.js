/**
 * One short phrase for what a run step produced — the result chip a card
 * wears under its name once its row has settled (StepNodeBase.jsx, mid and
 * near LOD). During a demo the run result says more than the config summary.
 *
 *   failed / error       → "failed"
 *   skipped              → "skipped"
 *   settled with output  → a Condition that kept part of a list (the filter's
 *                          `{ items, inputCount, rejectedCount }`): "3 of 4
 *                          kept"; an array: "{n} items"; an object holding a list
 *                          under files/items/results/rows/events/entries:
 *                          "{n} files" | "{n} rows" | "{n} items"; an object
 *                          that reports appended/created/uploaded/sent: "done";
 *                          a string: "{n} characters" (or "nothing" when
 *                          empty); null, [] or {}: "nothing"
 *   running / queued / awaiting … → null (nothing to say yet)
 *
 * Pure. `t(key, fallback, params)` is the app's translator; the keys live in
 * both dictionaries under automations.canvas.result.*. Never inspects VALUES —
 * counts and shapes only, so a chip can never leak what a step read.
 */
const LIST_KEYS = ['files', 'items', 'results', 'rows', 'events', 'entries'];
const OK_FLAGS = ['created', 'uploaded', 'sent'];
const OPEN_STATES = new Set(['running', 'queued', 'pending']);

function listChip(key, n, t) {
    if (n === 0) return t('automations.canvas.result.empty', 'nothing');
    if (key === 'files') return t('automations.canvas.result.files', '{n} files', { n });
    if (key === 'rows') return t('automations.canvas.result.rows', '{n} rows', { n });
    return t('automations.canvas.result.items', '{n} items', { n });
}

/** "3 of 4 kept": what a Condition that works through a list let through. */
function keptChip(out, t) {
    if (!Array.isArray(out.items) || typeof out.inputCount !== 'number' || typeof out.rejectedCount !== 'number') return null;
    return t('condition_node.canvas.kept', '{kept} of {total} kept', { kept: out.items.length, total: out.inputCount });
}

export function describeStepResult(row, t) {
    if (!row || typeof t !== 'function') return null;
    const status = String(row.status || '').toLowerCase();
    if (!status || OPEN_STATES.has(status) || status.startsWith('awaiting')) return null;
    if (status === 'error' || status === 'failed') return t('automations.canvas.result.failed', 'failed');
    if (status === 'skipped') return t('automations.canvas.result.skipped', 'skipped');

    const out = row.output;
    if (out == null) return t('automations.canvas.result.empty', 'nothing');
    if (Array.isArray(out)) return listChip('items', out.length, t);
    if (typeof out === 'string') {
        return out.length > 0
            ? t('automations.canvas.result.chars', '{n} characters', { n: out.length })
            : t('automations.canvas.result.empty', 'nothing');
    }
    if (typeof out === 'object') {
        // A server-truncated output is a placeholder, not a shape to count.
        if (out.__truncated__ === true) return t('automations.canvas.result.ok', 'done');
        const kept = keptChip(out, t);
        if (kept) return kept;
        for (const key of LIST_KEYS) {
            if (Array.isArray(out[key])) return listChip(key, out[key].length, t);
        }
        if (out.appended === true || OK_FLAGS.some((f) => !!out[f])) return t('automations.canvas.result.ok', 'done');
        if (Object.keys(out).length === 0) return t('automations.canvas.result.empty', 'nothing');
        return t('automations.canvas.result.ok', 'done');
    }
    // A number or a boolean: the step produced a value.
    return t('automations.canvas.result.ok', 'done');
}
