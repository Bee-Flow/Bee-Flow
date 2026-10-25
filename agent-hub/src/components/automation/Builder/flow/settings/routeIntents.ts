/**
 * "Suggest outputs" — the OFFLINE intent catalogue behind the Condition
 * node's plain-words box. Pure: no React, no network, no model.
 *
 * WHY THIS EXISTS
 * A Condition rule's predicate is a restricted-grammar expression
 * (server/automation/expr.js → shared/expr). "Is this a Word file" is
 *     equals(fileType(item), "word")
 * and on mails, where the files sit in a list inside each message,
 *     anyOf(fileType(item.attachments[*]), "equals", "word")
 * which checks EVERY attachment. Nobody types either by hand, and the
 * obvious hand-built rule ("Attachments contains pdf", or an "ends with" on
 * a list column, which only sees the last entry) matches nothing — with no
 * error anywhere, because "nothing matched" is a perfectly legal result.
 * The node cannot be told in words what it should do, so this module is the
 * part that listens.
 *
 * WHY IT IS LOCAL AND NOT A MODEL CALL
 * A self-hosted box may have no LLM configured at all — that is the whole
 * point of the product — and the example above is the one that motivated the
 * feature. Answering it offline means the box works on day one, costs
 * nothing, cannot drift between releases, and can be pinned by tests that
 * assert exact expressions. A model call, if it is ever added, belongs BEHIND
 * this catalogue as the fallback for what it could not parse, never in front
 * of it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *  - It never guesses which field to compare when nothing in the sample looks
 *    right. Silently picking a field produces rules that look correct in the
 *    preview and match nothing at runtime, which is exactly the failure this
 *    feature exists to remove. It returns a `problem` sentence instead.
 *  - It does not understand relative dates ("last week", "older than 30
 *    days"). Those need the run's clock, which no pure function here has;
 *    `problem` says so rather than inventing a fixed date.
 *  - It never writes anything. The caller previews the rules and applies them
 *    through the editor's normal path (flow/routeModel.js writeRoute), so a
 *    suggested single rule still saves as a `filter` and several still save as
 *    a `switch`, exactly like hand-built ones.
 */
import { tryEvaluate } from '@shared/expr/engine.mjs';
import { fileTypesNamedIn } from '@shared/expr/rules.mjs';
import { fileTarget, isPlainOption } from './routeIntentsFiles';
import { pickTopicField, readTopics } from './routeTopicIntent';
import type { DateClause, IntentContext, IntentResult, IntentRule, MatchCountOptions, NumberClause, SuggestOptions } from './routeIntents.types';
import { MAX_RULES, NUMBER_SYMBOL, NUMBER_WORD } from './routeIntents.constants';
import { result, quote, nextDay, pickFileField, pickTextField, pickNumberField, pickDateField, namedField, findPhrases, findDateClauses, findNumberClauses, unrecognised } from './routeIntents.helpers';

/** A port name: lowercase, word characters only — it labels an edge on the canvas. */
export function slugName(text?: unknown) {
    const s = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return s || 'output';
}

function dateRules(clauses: DateClause[], path: string) {
    const rules: IntentRule[] = [];
    for (const c of clauses) {
        if (c.kind === 'between') {
            const end = nextDay(c.b as string);
            if (!end) continue;
            rules.push({ name: slugName(`between ${c.a} and ${c.b}`), expr: `${path} >= ${quote(c.a)} && ${path} < ${quote(end)}` });
        } else if (c.kind === 'before') {
            rules.push({ name: slugName(`before ${c.a}`), expr: `${path} < ${quote(c.a)}` });
        } else if (c.kind === 'after') {
            const from = nextDay(c.a);
            if (!from) continue;
            rules.push({ name: slugName(`after ${c.a}`), expr: `${path} >= ${quote(from)}` });
        } else if (c.kind === 'since') {
            rules.push({ name: slugName(`since ${c.a}`), expr: `${path} >= ${quote(c.a)}` });
        } else if (c.kind === 'on') {
            const end = nextDay(c.a);
            if (!end) continue;
            rules.push({ name: slugName(`on ${c.a}`), expr: `${path} >= ${quote(c.a)} && ${path} < ${quote(end)}` });
        }
    }
    return rules;
}

function numberRules(clauses: NumberClause[], path: string) {
    return clauses.map((c: NumberClause) => (c.kind === 'between'
        ? { name: slugName(`between ${c.a} and ${c.b}`), expr: `${path} >= ${c.a} && ${path} <= ${c.b}` }
        : { name: slugName(`${NUMBER_WORD[c.kind]} ${c.a}`), expr: `${path} ${NUMBER_SYMBOL[c.kind]} ${c.a}` }));
}

// ── The catalogue ───────────────────────────────────────────────────────
/**
 * Read a description and answer with named rules, or with a plain sentence
 * saying why it could not.
 *
 * `fields` are the SAME options the rule rows offer (`{ path, label, sample }`
 * — routeEditors.jsx builds them from the item sample or the upstream steps),
 * so a suggestion can only ever reference a field the author could have picked
 * by hand. With no fields there is no vocabulary and the answer is a problem,
 * never a guessed path: a rule against a field that does not exist matches
 * nothing at runtime and reports no error, which is the exact failure this box
 * is meant to end.
 *
 * `topics` says a topic classifier is installed, which lets a sentence about
 * MEANING become "is about" outputs (tryTopics, last in line).
 *
 * `element` is one item's sample: it says whether each item is a file, or
 * holds a list of files (an e-mail's attachments), which decides what a
 * file-type rule reads (S1) and whether the answer carries `filesInside`.
 */
export function suggestOutputs(text: unknown, { fields = [], topics = false, element = undefined }: SuggestOptions = {}): IntentResult {
    const src = String(text || '').trim();
    if (!src) return result({});
    if (!(fields || []).length) {
        return result({
            problem: 'There is no sample data for this step yet, so there are no field names to build rules from. Run the step above once, or add the outputs by hand.',
        });
    }
    const lower = src.toLowerCase();
    // Only plain fields are compared directly; list columns and lists of
    // records need a quantifier, which only the file-type reader writes.
    const plain = fields.filter(isPlainOption);
    const ctx: IntentContext = {
        src, lower, fields: plain, named: namedField(lower, plain), topics,
        element, allFields: fields, namedAny: namedField(lower, fields),
    };
    for (const intent of INTENTS) {
        const answer = intent(ctx);
        if (answer) return answer;
    }
    return unrecognised(ctx);
}

// The intents, in the order they are tried. Most specific first: "between
// 2026-01-01 and 2026-01-31" must be read as dates before the number reader
// sees a "between … and …" it would half-understand.
const INTENTS: Array<(ctx: IntentContext) => IntentResult | null> = [tryFileTypes, tryDates, tryNumbers, tryPhrases, tryTopics];

function tryFileTypes({ lower, allFields, namedAny, element }: IntentContext) {
    const types = fileTypesNamedIn(lower);
    if (!types.length) return null;
    const target = fileTarget({ named: namedAny, element, fields: allFields, pickField: pickFileField });
    if (!target) {
        return result({ problem: 'Nothing here looks like a file name, so there is nothing to check the extension against. Name the field in your description — for example “file name is a pdf” — or add the outputs by hand.' });
    }
    return result({
        kind: 'fileType',
        understood: 'Split by file type',
        field: target.field,
        // Each output is named with the word the author used ("csv" stays
        // csv, although it is the excel type), so it reads back as asked.
        rules: types.map((t: { word: string; key: string }) => ({ name: slugName(t.word), expr: target.expr(t.key) })),
        truncated: types.length > MAX_RULES,
        filesInside: target.filesInside,
    });
}

function tryDates({ lower, fields, named }: IntentContext) {
    const clauses = findDateClauses(lower);
    if (!clauses.length) return null;
    const field = named || pickDateField(fields);
    if (!field) {
        return result({ problem: 'Say which field holds the date — for example “created is before 2026-01-01”.' });
    }
    const rules = dateRules(clauses, field.path);
    if (!rules.length) return null;
    return result({ kind: 'date', understood: 'Compare dates', field, rules, truncated: rules.length > MAX_RULES });
}

function tryNumbers({ lower, fields, named }: IntentContext) {
    const clauses = findNumberClauses(lower);
    if (!clauses.length) return null;
    const field = named || pickNumberField(fields);
    if (!field) {
        return result({ problem: 'Say which field holds the number — for example “amount over 1000”.' });
    }
    return result({
        kind: 'number',
        understood: 'Compare numbers',
        field,
        rules: numberRules(clauses, field.path),
        truncated: clauses.length > MAX_RULES,
    });
}

function tryPhrases({ src, fields, named }: IntentContext) {
    const phrases = findPhrases(src);
    if (!phrases.length) return null;
    const field = named || pickTextField(fields);
    if (!field) {
        return result({ problem: 'Say which field to look in — for example “subject contains urgent”.' });
    }
    return result({
        kind: 'contains',
        understood: 'Look for words',
        field,
        rules: phrases.map((p: string) => ({ name: slugName(p), expr: `contains(${field.path}, ${quote(p)})` })),
        truncated: phrases.length > MAX_RULES,
    });
}

// Routing by meaning ("split complaints from invoices"), answered by the topic
// classifier. Last, and only when one is installed: every intent above is an
// exact rule, and an exact rule the author asked for beats a judgement call.
function tryTopics({ src, fields, named, topics }: IntentContext) {
    if (!topics) return null;
    // A field the author named says where to read, so it is not a topic.
    const found = readTopics(src, named ? ([named.label, named.path.split('.').pop()] as string[]) : []);
    if (!found.length) return null;
    const field = named || pickTopicField(fields);
    if (!field) {
        return result({ problem: 'Say which field holds the text to read, for example “split the body into complaints and invoices”.' });
    }
    return result({
        kind: 'topic',
        understood: 'Sort by what the text is about',
        field,
        rules: found.map((t: string) => ({ name: slugName(t), expr: `isAbout(${field.path}, ${quote(t)})` })),
        truncated: found.length > MAX_RULES,
    });
}

/**
 * How many sample rows each suggested rule would take, and how many would
 * match nothing at all.
 *
 * The rules are evaluated with the SAME engine the server runs
 * (shared/expr — a byte-identical copy, pinned by a sync test), so the count
 * is the count, not an approximation of one. `tryEvaluate` never throws: a
 * row missing the field is a non-match, which is what the runtime does too.
 *
 * Returns null when there are no real sample rows. That null is the point:
 * with one made-up row a preview reads "1 of 1 matched", which is the most
 * reassuring and least informative thing it could possibly say.
 */
export function matchCounts(rules: Array<{ name?: string; expr?: string }>, rows: unknown[] | null, { root = null, itemVar = 'item', host = null }: MatchCountOptions = {}) {
    if (!Array.isArray(rows) || !Array.isArray(rules) || !rules.length) return null;
    const base = (root && typeof root === 'object' && !Array.isArray(root)) ? root : null;
    const perRule = rules.map((r: { name?: string }) => ({ name: r.name, matched: 0, failed: 0 }));
    let unmatched = 0;
    rows.forEach((row: unknown, index: number) => {
        // The run's scope for a list rule: the item and its position.
        const scope = { ...base, [itemVar]: row, _index: index };
        let any = false;
        rules.forEach((r: { expr?: string }, i: number) => {
            // `host` answers "is about" rules from the classifier's scores
            // for these rows (topicPreview.ts); without it they cannot be
            // counted and report as failed, which the caller says in words.
            const { value, error } = tryEvaluate(r.expr, scope, host ? { host } : undefined);
            if (error) { perRule[i].failed += 1; return; }
            if (value) { perRule[i].matched += 1; any = true; }
        });
        if (!any) unmatched += 1;
    });
    return { total: rows.length, perRule, unmatched };
}
