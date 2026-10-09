/**
 * Consent to bind an EXISTING datatable (pure; no db, no state).
 *
 * The assistant must not wire a flow to a table the user never chose: a model
 * that sees "Facturen" in the Datatables block and picks it would write rows
 * into somebody's real data. In a chat work mode a step may therefore only be
 * bound to an existing table when
 *   - the user named it (their own words, never the model's questions),
 *   - the user picked it on a question card (builder_ask_questions with
 *     datatableIds),
 *   - the flow already uses it, or an approved plan lists it, or
 *   - the assistant itself created it in this session.
 * Anything else is refused with `datatable_choice_required` and an `_askArgs`
 * the model passes to builder_ask_questions.
 *
 * `draftWrap._approvedDatatableIds` is the approved Set; null/absent turns the
 * gate off (MCP, where the caller is the user's own agent, and any turn
 * outside a work mode). A table the proposal STAGED (`pending`) always passes:
 * the user sees it in the proposal and creating it is their Apply.
 *
 * parseAnswersText (questionAnswers.js) reads the "Q: ...\nA: ..." text the chat
 * sends after a question card.
 */

'use strict';

const { boundDatatableIds } = require('./pendingDatatables');
const { parseAnswersText } = require('./questionAnswers');

// ── reading what the user said ─────────────────────────────────────────────

const oneLine = (text) => String(text ?? '').replace(/\s*\n\s*/g, ' ').trim();

/**
 * What the USER said in a message. In a Q/A message the "Q:" lines are the
 * model's own questions: a table named only there is not a table the user
 * named, so only the answers count.
 */
function answerTextOf(text) {
    const parsed = parseAnswersText(text);
    return parsed ? parsed.map((p) => p.answer).join('\n') : String(text ?? '');
}

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const escapeRegExp = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Same lookarounds as namesPhrase in workMode.js: "log" is not inside "catalog".
const namesPhrase = (text, phrase) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}_])`, 'u').test(text);

/** Ids of the (real) catalog tables the texts name: by name, key or exact id, as whole phrases. */
function namedTableIds(texts, catalog) {
    const haystack = (Array.isArray(texts) ? texts : []).map(fold).join('\n');
    const out = [];
    if (!haystack.trim()) return out;
    for (const t of Array.isArray(catalog) ? catalog : []) {
        if (!t || t.pending || !t.id) continue;
        const phrases = new Set();
        const name = fold(t.name).trim();
        if (name.length >= 3) phrases.add(name);
        const key = fold(t.key).trim();
        if (key.length >= 3) { phrases.add(key); phrases.add(key.replace(/_/g, ' ')); }
        const id = fold(t.id).trim();
        if (id.length >= 3) phrases.add(id);
        if ([...phrases].some((p) => namesPhrase(haystack, p))) out.push(t.id);
    }
    return out;
}

/**
 * The user's answer to a table question card (builder_ask_questions with
 * datatableIds). `questions` are the stored review questions (with the
 * server-only `choice`), `message` the chat message that answers them.
 *
 * `tables` repeats the approved ids as {id, key, name} rows, for the note the
 * next turn's agent reads.
 *
 * @returns {{approvedIds: string[], createFor: string[], tables: object[]}}
 */
function resolveTableChoice({ questions, message, catalog } = {}) {
    const out = { approvedIds: [], createFor: [], tables: [] };
    const answers = parseAnswersText(message);
    if (!answers) return out;
    const norm = (s) => oneLine(s).replace(/\s+/g, ' ').toLowerCase();
    for (const { prompt, answer } of answers) {
        const q = (Array.isArray(questions) ? questions : []).find((x) => x && x.choice && norm(x.prompt) === norm(prompt));
        if (!q) continue;
        const options = q.choice.options || [];
        const hit = options.find((o) => norm(o.label) === norm(answer));
        if (hit) {
            if (hit.create) out.createFor.push(oneLine(prompt));
            else if (hit.datatableId) out.approvedIds.push(hit.datatableId);
            continue;
        }
        // Typed instead of picked: exactly one of THIS question's tables named.
        const candidates = options.filter((o) => o.datatableId).map((o) => (catalog || []).find((t) => t && t.id === o.datatableId)).filter(Boolean);
        const named = namedTableIds([answer], candidates);
        if (named.length === 1) out.approvedIds.push(named[0]);
    }
    out.tables = out.approvedIds
        .map((id) => (catalog || []).find((t) => t && t.id === id))
        .filter(Boolean)
        .map((t) => ({ id: t.id, key: t.key, name: t.name }));
    return out;
}

// ── the approved set ───────────────────────────────────────────────────────

/**
 * @returns {Set<string>|null} null when the catalog is unreadable: no
 *   decision can be made, so the gate stays off rather than blocking everything.
 */
function buildApprovedSet({ catalog, defs = [], userTexts = [], carried = [], choice = null, planUse = [] } = {}) {
    if (!Array.isArray(catalog)) return null;
    const set = new Set();
    for (const d of defs) if (d && typeof d === 'object') for (const id of boundDatatableIds(d)) set.add(id);
    for (const id of Array.isArray(carried) ? carried : []) if (typeof id === 'string') set.add(id);
    for (const id of namedTableIds(userTexts.map(answerTextOf), catalog)) set.add(id);
    for (const id of choice?.approvedIds || []) set.add(id);
    for (const id of Array.isArray(planUse) ? planUse : []) if (typeof id === 'string') set.add(id);
    return set;
}

// ── the gate ───────────────────────────────────────────────────────────────

const tokens = (t) => new Set(fold(`${t.name || ''} ${t.key || ''}`).split(/[^a-z0-9]+/).filter((w) => w.length >= 3));

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

/** null = the step may bind this table; otherwise the refusal to return. */
function approvalGateError(table, draftWrap, { op = null } = {}) {
    const approved = draftWrap && draftWrap._approvedDatatableIds;
    if (!(approved instanceof Set)) return null;
    if (!table || table.pending || approved.has(table.id)) return null;
    return choiceRequiredError(table, draftWrap, { op });
}

module.exports = {
    parseAnswersText, answerTextOf, namedTableIds, resolveTableChoice, buildApprovedSet,
    choiceRequiredError, approvalGateError,
};
