/**
 * "Suggest outputs" — the OFFLINE intent catalogue behind the Condition node's
 * plain-words box. Pure: no model call, so it works on a box with no LLM
 * configured and can be pinned by tests that assert exact expressions. It never
 * guesses a field and never resolves a relative date; it answers with a
 * `problem` sentence instead. Port of agent-hub
 * `Builder/flow/settings/routeIntents.js`; pinned by settings.lockstep.test.ts.
 */

import { translate as t } from '@/core/i18n';
import { appendKey, fileTypesNamedIn, tryEvaluate } from '@/shared/expr';

import {
    dateRules, findDateClauses, findNumberClauses, findPhrases, numberRules, quote, type Rule, slugName,
} from './routeIntentClauses';
import { type IntentField, namedField, pickDateField, pickFileField, pickNumberField, pickTextField } from './routeIntentFields';
import { fileTarget, filesListKey, type FilesInside, isPlainOption, itemIsFile, listTarget, mentionsFiles } from './routeIntentFiles';

export { slugName };
export type { FilesInside };

// More outputs than this is a lookup table, not a routing decision.
const MAX_RULES = 8;

export interface Suggestion {
    kind: string | null;
    understood: string;
    field: IntentField | null;
    rules: Rule[];
    problem: string | null;
    /** 'name_types': about files, but no type named. */
    problemCode: string | null;
    truncated: boolean;
    /** The files sit in a list inside each item: the box offers to work through them instead (S4). */
    filesInside: FilesInside | null;
}

/** Port names must be unique — two cases with one name is an unwireable node. */
function withUniqueNames(rules: Rule[]): Rule[] {
    const seen = new Set<string>();
    return rules.map((r) => {
        let name = r.name;
        let i = 1;
        while (seen.has(name)) name = `${r.name}_${++i}`;
        seen.add(name);
        return { ...r, name };
    });
}

function result(r: Partial<Suggestion>): Suggestion {
    return {
        kind: r.kind ?? null,
        understood: r.understood ?? '',
        field: r.field ?? null,
        rules: withUniqueNames(r.rules ?? []).slice(0, MAX_RULES),
        problem: r.problem ?? null,
        problemCode: r.problemCode ?? null,
        truncated: r.truncated ?? false,
        filesInside: r.filesInside ?? null,
    };
}

interface Ctx {
    src: string;
    lower: string;
    /** The plain fields (one value per item): the only ones compared directly. */
    fields: IntentField[];
    named: IntentField | null;
    /** Every option of the rule menu, list columns and File type entries included. */
    allFields: IntentField[];
    namedAny: IntentField | null;
    /** One item's sample: is it a file, or does it hold a list of files? */
    element: unknown;
}

function tryFileTypes({ lower, allFields, namedAny, element }: Ctx): Suggestion | null {
    const types = fileTypesNamedIn(lower);
    if (!types.length) return null;
    const target = fileTarget(namedAny, element, allFields, pickFileField);
    if (!target) {
        return result({ problem: t('mobile.flow.suggest.no_file_field', 'Nothing here looks like a file name, so there is nothing to check the extension against. Name the field in your description — for example “file name is a pdf” — or add the outputs by hand.') });
    }
    // Each output keeps the author's word ("csv" stays csv, though it is the excel type).
    const rules = types.map((ft) => ({ name: slugName(ft.word), expr: target.expr(ft.key) }));
    return result({
        kind: 'fileType', understood: t('mobile.flow.suggest.split_file_type', 'Split by file type'), field: target.field,
        rules, truncated: types.length > MAX_RULES, filesInside: target.filesInside,
    });
}

function tryDates({ lower, fields, named }: Ctx): Suggestion | null {
    const clauses = findDateClauses(lower);
    if (!clauses.length) return null;
    const field = named || pickDateField(fields);
    if (!field) return result({ problem: t('mobile.flow.suggest.no_date_field', 'Say which field holds the date — for example “created is before 2026-01-01”.') });
    const rules = dateRules(clauses, field.path as string);
    if (!rules.length) return null;
    return result({ kind: 'date', understood: t('mobile.flow.suggest.compare_dates', 'Compare dates'), field, rules, truncated: rules.length > MAX_RULES });
}

function tryNumbers({ lower, fields, named }: Ctx): Suggestion | null {
    const clauses = findNumberClauses(lower);
    if (!clauses.length) return null;
    const field = named || pickNumberField(fields);
    if (!field) return result({ problem: t('mobile.flow.suggest.no_number_field', 'Say which field holds the number — for example “amount over 1000”.') });
    const rules = numberRules(clauses, field.path as string);
    return result({ kind: 'number', understood: t('mobile.flow.suggest.compare_numbers', 'Compare numbers'), field, rules, truncated: clauses.length > MAX_RULES });
}

function tryPhrases({ src, fields, named }: Ctx): Suggestion | null {
    const phrases = findPhrases(src);
    if (!phrases.length) return null;
    const field = named || pickTextField(fields);
    if (!field) return result({ problem: t('mobile.flow.suggest.no_text_field', 'Say which field to look in — for example “subject contains urgent”.') });
    const rules = phrases.map((p) => ({ name: slugName(p), expr: `contains(${field.path}, ${quote(p)})` }));
    return result({ kind: 'contains', understood: t('mobile.flow.suggest.look_for_words', 'Look for words'), field, rules, truncated: phrases.length > MAX_RULES });
}

// Most specific first: a date range must be read before the number reader sees "between … and …".
const INTENTS = [tryFileTypes, tryDates, tryNumbers, tryPhrases];

// A date was meant, but not in a form a pure function can resolve.
const DATE_WORDS = /\b(before|after|since|older than|newer than|last (?:week|month|year|\d+ days?)|this (?:week|month|year)|yesterday|today|tomorrow|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\b/;

/**
 * A description → named rules, or a plain sentence saying why not. `fields`
 * are the options the rule rows offer, so a suggestion only ever references a
 * field the author could have picked by hand.
 */
export function suggestOutputs(text: unknown, { fields = [], element = undefined }: { fields?: IntentField[]; element?: unknown } = {}): Suggestion {
    const src = String(text || '').trim();
    if (!src) return result({});
    if (!(fields || []).length) {
        return result({ problem: t('mobile.flow.suggest.no_sample', 'There is no sample data for this step yet, so there are no field names to build rules from. Run the step above once, or add the outputs by hand.') });
    }
    const lower = src.toLowerCase();
    const plain = fields.filter(isPlainOption);
    const ctx: Ctx = { src, lower, fields: plain, named: namedField(lower, plain), allFields: fields, namedAny: namedField(lower, fields), element };
    for (const intent of INTENTS) {
        const answer = intent(ctx);
        if (answer) return answer;
    }
    return unrecognised(ctx);
}

/** The sentence for a description no intent answered. */
function unrecognised({ lower, element, allFields }: Ctx): Suggestion {
    const isFile = itemIsFile(element, allFields);
    const listKey = isFile ? null : filesListKey(element, allFields);
    if (mentionsFiles(lower) && (isFile || listKey)) {
        // About files, but no type named: say which words work, and still offer the files inside (S4).
        return result({
            problem: t('condition_node.suggest.name_types', 'Name the file types to split by, for example “pdf, word and powerpoint”.'),
            problemCode: 'name_types',
            filesInside: listKey ? listTarget(appendKey('item', listKey), allFields).filesInside : null,
        });
    }
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- one alternation of fixed words and bounded digit runs between word boundaries, no nested quantifiers: linear in the sentence
    if (DATE_WORDS.test(lower)) {
        return result({ problem: t('mobile.flow.suggest.full_dates', 'Dates have to be written in full, as 2026-01-31. A date relative to today (“last week”) is not something this box can work out on its own.') });
    }
    return result({ problem: t('mobile.flow.suggest.nothing', 'Nothing recognised there yet. Try a file type (pdf, word, excel, powerpoint), words in quotes to look for, a date range written as 2026-01-31, or a number comparison such as “amount over 1000”.') });
}

export interface MatchCounts {
    total: number;
    perRule: { name: string; matched: number; failed: number }[];
    unmatched: number;
}

/**
 * How many sample rows each rule takes, and how many match nothing — with the
 * SAME engine the server runs. Null without real rows: "1 of 1 matched" on a
 * made-up row is the most reassuring and least informative answer there is.
 */
export function matchCounts(
    rules: Rule[] | null | undefined,
    rows: unknown[] | null | undefined,
    { root = null, itemVar = 'item' }: { root?: unknown; itemVar?: string } = {},
): MatchCounts | null {
    if (!Array.isArray(rows) || !Array.isArray(rules) || !rules.length) return null;
    const base = root && typeof root === 'object' && !Array.isArray(root) ? root : null;
    const perRule = rules.map((r) => ({ name: r.name, matched: 0, failed: 0 }));
    let unmatched = 0;
    rows.forEach((row, index) => {
        // The run's scope for a list rule: the item and its position.
        const scope = { ...(base as object), [itemVar]: row, _index: index };
        let any = false;
        rules.forEach((r, i) => {
            const { value, error } = tryEvaluate(r.expr, scope);
            const tally = perRule[i] as MatchCounts['perRule'][number];
            if (error) tally.failed += 1;
            else if (value) {
                tally.matched += 1;
                any = true;
            }
        });
        if (!any) unmatched += 1;
    });
    return { total: rows.length, perRule, unmatched };
}
