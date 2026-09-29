/**
 * Builder tools — builder_add_note: the free-floating canvas annotation, the
 * one builder that deliberately wires no edge at all.
 */

const { newId } = require('../draftGraph');
const {
    NOTE_MAX_TEXT_LENGTH, NOTE_MIN_SIZE, NOTE_MAX_SIZE, NOTE_COLOR_KEYS,
} = require('../../validate/constants');

/**
 * A free-floating canvas annotation (BFSF-411). Deliberately NOT built through
 * `appendAfter`: every other builder_add_* wires its step into the flow with
 * an edge (from `afterStepId`, or the trigger by default) — a note has no
 * afterStepId/branch/caseName in its schema at all, so there is nothing to
 * wire, and pushing straight onto `draft.steps` is what keeps the guarantee
 * that a note NEVER carries an edge (validate/graph.js's `edge.note_no_edges`
 * enforces the same thing from the other side, for hand-edited/AI-authored
 * definitions this builder didn't produce).
 *
 * Bounds are IMPORTED from validate/constants.js (NOTE_MAX_TEXT_LENGTH,
 * NOTE_MIN_SIZE/MAX_SIZE, NOTE_COLOR_KEYS) rather than restated — the same
 * discipline DATATABLE_OPS above follows, so a clamp can never drift from
 * what stepRules.js's note.* checks actually enforce on save.
 */
function sanitizeNoteSize(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const size = {};
    for (const k of ['width', 'height']) {
        const v = Number(raw[k]);
        if (Number.isFinite(v)) size[k] = Math.min(NOTE_MAX_SIZE, Math.max(NOTE_MIN_SIZE, Math.round(v)));
    }
    return Object.keys(size).length ? size : undefined;
}

function applyAddNote(draft, args) {
    if (typeof args.text !== 'string' || !args.text.trim()) {
        return { error: 'text is required — what should the note say?' };
    }
    const step = {
        id: newId('note'),
        type: 'note',
        text: args.text.slice(0, NOTE_MAX_TEXT_LENGTH),
        label: args.label || 'Note',
    };
    if (args.position && typeof args.position === 'object'
        && Number.isFinite(Number(args.position.x)) && Number.isFinite(Number(args.position.y))) {
        step.position = { x: Number(args.position.x), y: Number(args.position.y) };
    }
    const size = sanitizeNoteSize(args.size);
    if (size) step.size = size;
    if (typeof args.color === 'string' && NOTE_COLOR_KEYS.has(args.color)) step.color = args.color;
    draft.steps.push(step);
    return { added: step };
}

module.exports = {
    sanitizeNoteSize,
    applyAddNote,
    NOTE_MAX_TEXT_LENGTH,
    NOTE_COLOR_KEYS,
};
