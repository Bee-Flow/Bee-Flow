// @typecheck
/**
 * builder_update_step on a read_table or table step: `source` and `ops`
 * checked through the add path's helpers (a path must exist in the draft, an
 * operation list is replaced wholesale and normalised), and the settings the
 * patch touches judged by the shared specs. Only the findings under a patched
 * field can refuse the patch, so an unrelated problem elsewhere in the step
 * never blocks fixing the field at hand.
 */

const {
    fixSource, fixOpBindings, findingsRefusal, SOURCE_HINT_READ, SOURCE_HINT_TABLE,
} = require('../../stepBuilders/tableSteps');
const { validateReadTableStep } = require('../../../../core/automationModel/tableOps/readTableSpec');

const READ_TABLE_KEYS = ['source', 'sheets', 'headerRow', 'provenanceSheet', 'format', 'delimiter', 'skipHiddenSheets', 'expiresInDays'];
const TABLE_KEYS = ['source', 'ops', 'name', 'expiresInDays'];

/**
 * @param {string[]} keys
 */
const underPatched = (/** @type {{ path: string; }} */ f, keys) => keys.some(k => f.path === k || f.path.startsWith(`${k}[`) || f.path.startsWith(`${k}.`));

/**
 * A refusal, or null. Mutates `next` (source and ops).
 * @param {string[]} patchNotes
 */
function patchTableStep(graph, step, patch, next, draftWrap, patchNotes) {
    const isRead = step.type === 'read_table';
    if (!isRead && step.type !== 'table') return null;
    const keys = (isRead ? READ_TABLE_KEYS : TABLE_KEYS).filter(k => k in patch);
    if (!keys.length) return null;

    if ('source' in patch) {
        const src = fixSource(patch.source, graph, draftWrap, isRead ? SOURCE_HINT_READ : SOURCE_HINT_TABLE);
        if (src.error) return { error: src.error, ...(src._fixHint ? { _fixHint: src._fixHint } : {}) };
        next.source = src.source;
        patchNotes.push(...src.notes);
    }
    if (!isRead && 'ops' in patch) {
        if (!Array.isArray(patch.ops)) return findingsRefusal('table', [{ severity: 'error', path: 'ops', message: 'The operations must be a list.' }]);
        const bound = fixOpBindings(patch.ops, graph, draftWrap);
        if (bound.errors.length) {
            return { error: `table: ${bound.errors.join(' | ')}`, _fixHint: 'Reject reason: a reference in an operation does not resolve. Fix the named path and resend the patch; the other settings were fine.' };
        }
        patchNotes.push(...bound.notes);
        next.ops = bound.ops;
    }

    const candidate = { ...step, ...patch, source: next.source, ...(next.ops ? { ops: next.ops } : {}) };
    const tableSpec = () => /** @type {typeof import('../../../../core/automationModel/tableOps/spec')} */ (require('../../../../core/automationModel/tableOps/spec'));
    const findings = (isRead ? validateReadTableStep(candidate) : tableSpec().validateTableStep(candidate))
        .filter((/** @type {{ path: string; }} */ f) => underPatched(f, keys));
    const refusal = findingsRefusal(step.type, findings);
    if (refusal) return refusal;
    // The operation list is stored in its normalised form, like a freshly added step's.
    if (!isRead && 'ops' in patch) next.ops = tableSpec().normalizeTableStep(candidate).ops;
    return null;
}

module.exports = { patchTableStep };

/** @typedef {import('../../pendingDatatables').DraftWrap} DraftWrap */

/** @typedef {import('../../draftGraph').DraftGraph} DraftGraph */
