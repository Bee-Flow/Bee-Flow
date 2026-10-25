/**
 * @param {string} s
 */
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const tokens = (t) => new Set(fold(`${t.name || ''} ${t.key || ''}`).split(/[^a-z0-9]+/).filter((w) => w.length >= 3));

/**
 * @param {boolean} write
 */
function alternatives(table, draftWrap, write) {
    const mine = tokens(table);
    return (draftWrap._datatables || [])
        .filter((t) => t && !t.pending && t.id !== table.id && (!write || t.canWrite))
        .map((t) => ({ t, score: [...tokens(t)].filter((w) => mine.has(w)).length }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2)
        .map((x) => x.t.id);
}

const ASK_HINT = 'Reject reason: existing table not chosen by the user. Call builder_ask_questions with _askArgs (write the prompt and createLabel in the user\'s language), say at most one sentence, and stop. Bind the step after the answer. Never pick a table yourself.';

/** The refusal for a table the user has not chosen; `sameName` = a create request that collides with it. */
function choiceRequiredError(table, draftWrap, { op = null, sameName = false } = {}) {
    const write = !!op && op !== 'find_rows' && op !== 'count_rows';
    return {
        error: sameName
            ? `A table called "${table.name}" already exists (${table.id}). Nothing was staged.`
            : `The user has not chosen the table "${table.name}" for this flow, so it is not bound.`,
        code: 'datatable_choice_required',
        _rejectedPath: 'datatableId',
        _askArgs: {
            questions: [{
                prompt: sameName ? `A table "${table.name}" already exists. Which table should this flow use?` : 'Which table should this flow use?',
                datatableIds: [table.id, ...alternatives(table, draftWrap, write)],
                createLabel: 'Create a new table',
            }],
        },
        _fixHint: ASK_HINT,
    };
}

module.exports = { fold, choiceRequiredError };
