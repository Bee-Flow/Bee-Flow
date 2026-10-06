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
import { appendKey } from '@shared/expr/path.mjs';
import { fileTypeOf, fileTypesNamedIn } from '@shared/expr/rules.mjs';
import {
    filesListKey, fileTarget, isPlainOption, itemIsFile, listTarget, mentionsFiles,
} from './routeIntentsFiles';
import { pickTopicField, readTopics } from './routeTopicIntent';

// More outputs than this is not a routing decision any more, it is a lookup
// table — and every extra output is a port on the canvas that someone has to
// wire. A description that produces more is truncated and says so.
const MAX_RULES = 8;

const ISO_DATE = '\\d{4}-\\d{2}-\\d{2}';
const ISO_DATE_RE = new RegExp(`^${ISO_DATE}$`);

// ── Small helpers ───────────────────────────────────────────────────────
function lastSegment(path) {
    const cleaned = String(path || '').replace(/\[(?:\*|\d+)\]/g, '');
    return cleaned.split('.').filter(Boolean).pop() || '';
}

function fieldKey(field) {
    return lastSegment(field?.path).toLowerCase();
}

/** A port name: lowercase, word characters only — it labels an edge on the canvas. */
export function slugName(text) {
    const s = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return s || 'output';
}

/** Port names must be unique — two cases with one name is an unwireable node. */
function withUniqueNames(rules) {
    const seen = new Set();
    return rules.map((r) => {
        let name = r.name;
        let i = 1;
        while (seen.has(name)) name = `${r.name}_${++i}`;
        seen.add(name);
        return { ...r, name };
    });
}

function result({
    kind = null, understood = '', field = null, rules = [], problem = null, problemCode = null,
    truncated = false, filesInside = null,
}) {
    return {
        kind, understood, field, rules: withUniqueNames(rules).slice(0, MAX_RULES),
        problem, problemCode, truncated, filesInside,
    };
}

function quote(value) {
    return JSON.stringify(String(value));
}

/**
 * The number in "over 1000". Only the COMMA is treated as a thousands
 * separator: in the expression grammar a dot is a decimal point, so reading
 * `1.000` as one thousand here would silently disagree with what the very
 * same characters mean in the generated expression.
 */
function parseNumber(raw) {
    const cleaned = String(raw || '').replace(/,/g, '').trim();
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
    return Number(cleaned);
}

/**
 * The day after an ISO date, as an ISO date.
 *
 * Date fields hold whole days ("2026-01-31") in some steps and full
 * timestamps ("2026-01-31T14:02:00Z") in others, and the expression engine
 * compares both as plain strings. `<= "2026-01-31"` therefore drops every row
 * timestamped ON the 31st — the classic "the last day of my range is missing"
 * report. An exclusive `< "2026-02-01"` bound is right for both shapes, so
 * ranges are built that way and the rule NAME keeps the date the author
 * actually typed.
 */
function nextDay(iso) {
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

// ── Picking the field to compare ────────────────────────────────────────
const FILE_NAME_KEYS = /^(file|files|filename|file_name|name|path|filepath|attachment|attachments|document)$/;
const TEXT_KEYS = /^(subject|title|name|body|text|message|content|description|summary|snippet)$/;
const NUMBER_KEYS = /(amount|total|price|count|quantity|qty|score|size|bytes|number|age|days)$/;
const DATE_KEYS = /(date|created|updated|modified|due|sent|received|timestamp|time|at)$/;

function bestField(fields, score, minimum = 2) {
    let best = null;
    let bestScore = 0;
    for (const f of (fields || [])) {
        if (!f?.path) continue;
        const s = score(f);
        if (s > bestScore) { best = f; bestScore = s; }
    }
    return bestScore >= minimum ? best : null;
}

function pickFileField(fields) {
    return bestField(fields, (f) => {
        if (Array.isArray(f.sample)) return 0;
        let s = 0;
        // A sample that names a known file type is the strongest signal there
        // is — stronger than any name. fileType reads "other" for anything it
        // does not know, so an e-mail address ending in ".nl" scores nothing.
        if (typeof f.sample === 'string' && fileTypeOf(f.sample) !== 'other') s += 3;
        const key = fieldKey(f);
        if (FILE_NAME_KEYS.test(key)) s += 2;
        else if (key === 'title') s += 1;
        return s;
    });
}

function pickTextField(fields) {
    return bestField(fields, (f) => {
        let s = 0;
        if (typeof f.sample === 'string') s += 1;
        if (TEXT_KEYS.test(fieldKey(f))) s += 2;
        return s;
    });
}

function pickNumberField(fields) {
    return bestField(fields, (f) => {
        let s = 0;
        if (typeof f.sample === 'number') s += 3;
        if (NUMBER_KEYS.test(fieldKey(f))) s += 2;
        return s;
    });
}

function pickDateField(fields) {
    return bestField(fields, (f) => {
        let s = 0;
        if (typeof f.sample === 'string' && /^\d{4}-\d{2}-\d{2}/.test(f.sample.trim())) s += 3;
        if (DATE_KEYS.test(fieldKey(f))) s += 2;
        return s;
    });
}

/**
 * A field the author NAMED in the description ("subject contains urgent").
 * What the author says wins over every heuristic below — they can see the
 * field list, the heuristics only see samples. Longest match wins so
 * "from email" is not shadowed by "from".
 */
function namedField(lower, fields) {
    let best = null;
    let bestLen = 0;
    for (const f of (fields || [])) {
        if (!f?.path) continue;
        const candidates = [f.label, fieldKey(f).replace(/_/g, ' '), fieldKey(f)]
            .filter(Boolean)
            .map(s => String(s).toLowerCase());
        for (const c of candidates) {
            if (c.length < 3 || c.length <= bestLen) continue;
            const re = new RegExp(`(?:^|[^a-z0-9])${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`);
            if (re.test(lower)) { best = f; bestLen = c.length; }
        }
    }
    return best;
}

// ── Intent: contains ────────────────────────────────────────────────────
const QUOTED_RE = /"([^"]+)"|'([^']+)'|“([^”]+)”/g;
// A bare "with" is NOT a lead-in. "do the usual thing with these" is not a
// request to match the word "these", and a box that answers a shrug with a
// confident rule is worse than one that says it did not understand.
const CONTAINS_LEAD = /\b(?:contains?|containing|mentions?|mentioning|includes?|including|with the words?)\s+(.+)$/i;

function findPhrases(src) {
    const quoted = [];
    let m;
    QUOTED_RE.lastIndex = 0;
    while ((m = QUOTED_RE.exec(src))) {
        const phrase = (m[1] || m[2] || m[3] || '').trim();
        if (phrase) quoted.push(phrase);
    }
    if (quoted.length) return quoted;
    const lead = CONTAINS_LEAD.exec(src);
    if (!lead) return [];
    return lead[1]
        .split(/\s*,\s*|\s+\band\b\s+|\s+\bor\b\s+|\s*\/\s*/i)
        .map(s => s.trim().replace(/[.!?]+$/, '').replace(/\bin (?:it|them|the (?:subject|body|text|title))\b/i, '').trim())
        .filter(s => s && s.length > 1);
}

// ── Intent: dates ───────────────────────────────────────────────────────
const DATE_CLAUSES = [
    { re: new RegExp(`\\bbetween\\s+(${ISO_DATE})\\s+(?:and|to|until)\\s+(${ISO_DATE})`, 'g'), kind: 'between' },
    { re: new RegExp(`\\b(?:before|earlier than|prior to|up to)\\s+(${ISO_DATE})`, 'g'), kind: 'before' },
    // "after the 1st" excludes the 1st; "since/from the 1st" includes it.
    // Two different asks, so two patterns — and the exclusive bound is built
    // from the NEXT day (see nextDay) so a timestamp at 09:00 on the 1st is
    // not quietly read as "after the 1st".
    { re: new RegExp(`\\bafter\\s+(${ISO_DATE})`, 'g'), kind: 'after' },
    { re: new RegExp(`\\b(?:since|from|on or after)\\s+(${ISO_DATE})`, 'g'), kind: 'since' },
    { re: new RegExp(`\\bon\\s+(${ISO_DATE})`, 'g'), kind: 'on' },
];

function findDateClauses(lower) {
    const out = [];
    for (const { re, kind } of DATE_CLAUSES) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(lower))) out.push({ kind, at: m.index, end: m.index + m[0].length, a: m[1], b: m[2] || null });
    }
    // The patterns overlap on purpose — "between A and B" contains something
    // the `on` pattern would match again, and one phrase must not become two
    // outputs. Earliest (and therefore longest-leading) clause wins its span;
    // anything starting inside an accepted span is the same phrase read twice.
    const kept = [];
    for (const c of out.sort((a, b) => (a.at - b.at) || (b.end - a.end))) {
        if (kept.some(k => c.at < k.end && c.end > k.at)) continue;
        kept.push(c);
    }
    return kept;
}

function dateRules(clauses, path) {
    const rules = [];
    for (const c of clauses) {
        if (c.kind === 'between') {
            const end = nextDay(c.b);
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

// A date was clearly meant, but not in a form a pure function can resolve.
const DATE_WORDS = /\b(before|after|since|older than|newer than|last (?:week|month|year|\d+ days?)|this (?:week|month|year)|yesterday|today|tomorrow|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\b/;

// ── Intent: numbers ─────────────────────────────────────────────────────
const NUM = '(-?[\\d][\\d,]*(?:\\.\\d+)?)';
const NUMBER_CLAUSES = [
    { re: new RegExp(`\\bbetween\\s+${NUM}\\s+(?:and|to)\\s+${NUM}`, 'g'), kind: 'between' },
    { re: new RegExp(`\\b(?:over|more than|greater than|above|higher than|bigger than)\\s+${NUM}`, 'g'), kind: 'gt' },
    { re: new RegExp(`\\b(?:under|less than|below|lower than|smaller than)\\s+${NUM}`, 'g'), kind: 'lt' },
    { re: new RegExp(`\\b(?:at least|minimum of|minimum|no less than)\\s+${NUM}`, 'g'), kind: 'gte' },
    { re: new RegExp(`\\b(?:at most|no more than|maximum of|maximum|up to)\\s+${NUM}`, 'g'), kind: 'lte' },
];

function findNumberClauses(lower) {
    const out = [];
    for (const { re, kind } of NUMBER_CLAUSES) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(lower))) {
            const a = parseNumber(m[1]);
            const b = m[2] == null ? null : parseNumber(m[2]);
            if (a == null || (kind === 'between' && b == null)) continue;
            out.push({ kind, at: m.index, end: m.index + m[0].length, a, b });
        }
    }
    // Same overlap rule as the dates, and here it is load-bearing rather than
    // tidy: "no more than 100" contains "more than 100", so without it the one
    // phrase becomes an at-most output AND an over output that says the
    // opposite. Earliest start, longest span wins.
    const kept = [];
    for (const c of out.sort((x, y) => (x.at - y.at) || (y.end - x.end))) {
        if (kept.some(k => c.at < k.end && c.end > k.at)) continue;
        kept.push(c);
    }
    return kept;
}

const NUMBER_SYMBOL = { gt: '>', lt: '<', gte: '>=', lte: '<=' };
const NUMBER_WORD = { gt: 'over', lt: 'under', gte: 'at least', lte: 'at most' };

function numberRules(clauses, path) {
    return clauses.map((c) => (c.kind === 'between'
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
 * @param {string} text
 * `element` is one item's sample: it says whether each item is a file, or
 * holds a list of files (an e-mail's attachments), which decides what a
 * file-type rule reads (S1) and whether the answer carries `filesInside`.
 *
 * @param {{ fields?: Array<{ path: string, label?: string, sample?: unknown, type?: string, quantified?: boolean, kind?: string }>, topics?: boolean, element?: unknown }} [opts]
 */
export function suggestOutputs(text, { fields = [], topics = false, element = undefined } = {}) {
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
    const ctx = {
        src, lower, fields: plain, named: namedField(lower, plain), topics,
        element, allFields: fields, namedAny: namedField(lower, fields),
    };
    for (const intent of INTENTS) {
        const answer = intent(ctx);
        if (answer) return answer;
    }
    return unrecognised(ctx);
}

/** The sentence for a description no intent answered. */
function unrecognised({ lower, element, allFields }) {
    if (mentionsFiles(lower) && (itemIsFile(element, allFields) || filesListKey(element, allFields))) {
        // About files, but no type named: say which words work, and (S4)
        // still offer to work through the files inside each item.
        const listKey = itemIsFile(element, allFields) ? null : filesListKey(element, allFields);
        return result({
            problem: 'Name the file types to split by, for example “pdf, word and powerpoint”.',
            problemCode: 'name_types',
            filesInside: listKey ? listTarget(appendKey('item', listKey), allFields).filesInside : null,
        });
    }
    if (DATE_WORDS.test(lower)) {
        // A relative date needs the run's clock, and a dd-mm-yyyy date is
        // ambiguous with mm-dd-yyyy. Both are refused out loud instead of
        // being resolved to a date the author never typed.
        return result({ problem: 'Dates have to be written in full, as 2026-01-31. A date relative to today (“last week”) is not something this box can work out on its own.' });
    }
    return result({
        problem: 'Nothing recognised there yet. Try a file type (pdf, word, excel, powerpoint), words in quotes to look for, a date range written as 2026-01-31, or a number comparison such as “amount over 1000”.',
    });
}

// The intents, in the order they are tried. Most specific first: "between
// 2026-01-01 and 2026-01-31" must be read as dates before the number reader
// sees a "between … and …" it would half-understand.
const INTENTS = [tryFileTypes, tryDates, tryNumbers, tryPhrases, tryTopics];

function tryFileTypes({ lower, allFields, namedAny, element }) {
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
        rules: types.map(t => ({ name: slugName(t.word), expr: target.expr(t.key) })),
        truncated: types.length > MAX_RULES,
        filesInside: target.filesInside,
    });
}

function tryDates({ lower, fields, named }) {
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

function tryNumbers({ lower, fields, named }) {
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

function tryPhrases({ src, fields, named }) {
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
        rules: phrases.map(p => ({ name: slugName(p), expr: `contains(${field.path}, ${quote(p)})` })),
        truncated: phrases.length > MAX_RULES,
    });
}

// Routing by meaning ("split complaints from invoices"), answered by the topic
// classifier. Last, and only when one is installed: every intent above is an
// exact rule, and an exact rule the author asked for beats a judgement call.
function tryTopics({ src, fields, named, topics }) {
    if (!topics) return null;
    // A field the author named says where to read, so it is not a topic.
    const found = readTopics(src, named ? [named.label, named.path.split('.').pop()] : []);
    if (!found.length) return null;
    const field = named || pickTopicField(fields);
    if (!field) {
        return result({ problem: 'Say which field holds the text to read, for example “split the body into complaints and invoices”.' });
    }
    return result({
        kind: 'topic',
        understood: 'Sort by what the text is about',
        field,
        rules: found.map(t => ({ name: slugName(t), expr: `isAbout(${field.path}, ${quote(t)})` })),
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
/**
 * @param {Array<{ name?: string, expr?: string }>} rules
 * @param {unknown[] | null} rows
 * @param {{ root?: unknown, itemVar?: string, host?: object | null }} [opts]
 */
export function matchCounts(rules, rows, { root = null, itemVar = 'item', host = null } = {}) {
    if (!Array.isArray(rows) || !Array.isArray(rules) || !rules.length) return null;
    const base = (root && typeof root === 'object' && !Array.isArray(root)) ? root : null;
    const perRule = rules.map(r => ({ name: r.name, matched: 0, failed: 0 }));
    let unmatched = 0;
    rows.forEach((row, index) => {
        // The run's scope for a list rule: the item and its position.
        const scope = { ...base, [itemVar]: row, _index: index };
        let any = false;
        rules.forEach((r, i) => {
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
