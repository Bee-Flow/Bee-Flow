// @typecheck
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

const { boundDatatableIds } = require('./boundDatatables');
const { parseAnswersText } = require('./questionAnswers');
const { fold, choiceRequiredError } = require('./choiceRequired');

// ── reading what the user said ─────────────────────────────────────────────

/**
 * @param {string} text
 */
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

const escapeRegExp = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Same lookarounds as namesPhrase in workMode.js: "log" is not inside "catalog".
// nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- the phrase is escaped literal text (no quantifiers), so the pattern is linear
/**
 * @param {string} text
 * @param {string} phrase
 */
const namesPhrase = (text, phrase) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}_])`, 'u').test(text);

/**
 * Ids of the (real) catalog tables the texts name: by name, key or exact id, as whole phrases.
 * @param {string[]} texts
 * @param {CatalogTable[] | null | undefined} catalog
 */
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
 * @param {{ questions?: ReviewQuestion[] | null, message?: unknown, catalog?: CatalogTable[] | null }} [args]
 * @returns {TableChoice}
 */
function resolveTableChoice({ questions, message, catalog } = {}) {
    /** @type {TableChoice} */
    const out = { approvedIds: [], createFor: [], tables: [] };
    const answers = parseAnswersText(message);
    if (!answers) return out;
    /**
     * @param {string} s
     */
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
 * @typedef {object} BuildApprovedSetArgs
 * @property {CatalogTable[] | null} [catalog]  the tables the caller can see; anything but a list turns the gate off
 * @property {unknown[]} [defs]  the definitions whose bound tables are already approved
 * @property {string[]} [userTexts]  what the user wrote (their own words only)
 * @property {unknown} [carried]  ids approved in an earlier turn
 * @property {TableChoice | null} [choice]
 * @property {unknown[]} [planUse]  ids an approved plan lists
 */
/**
 * @returns {Set<string>|null} null when the catalog is unreadable: no
 *   decision can be made, so the gate stays off rather than blocking everything.
 * @param {BuildApprovedSetArgs} [param0]
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

/**
 * @typedef {{ id?: string, key?: string, name?: string, pending?: boolean }} CatalogTable
 * @typedef {{ label?: string, create?: boolean, datatableId?: string }} ChoiceOption
 * @typedef {{ prompt?: string, choice?: { options?: ChoiceOption[] } }} ReviewQuestion
 * @typedef {{ approvedIds: string[], createFor: string[], tables: { id?: string, key?: string, name?: string }[] }} TableChoice
 */
