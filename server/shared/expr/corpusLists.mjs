// @typecheck strict
/**
 * Golden corpus cases for member access on a call result, the list functions
 * (map/filter/some/every, unique, sum with a field) and regexMatch /
 * regexReplace, evaluated against corpus.mjs's SCOPE. corpus.mjs spreads them
 * into CASES and REJECT, so every runner of the corpus (server, browser
 * parity: RE2 against the native engine) runs them too. The cases of the
 * collection functions, the literals and `??` (corpusCollections.mjs) ride along.
 */

import { COLLECTION_CASES, COLLECTION_REJECT } from './corpusCollections.mjs'; // literals, ??, sort … reduce

export const LIST_CASES = [
    // member access on a call result or a parenthesised value
    { expr: 'parseJson(rawJson).user.name', expected: 'Ada' },
    { expr: 'find(actions.search.result.rows, "name", "b").name', expected: 'B' },
    { expr: 'first(actions.search.result.rows).name', expected: 'A' },
    { expr: 'last(table)["bank"]', expected: 'ABN | AMRO' },
    { expr: '(missing.x || item).region', expected: 'EU' },
    { expr: 'split("a,b,c", ",")[1]', expected: 'b' },
    { expr: 'first(missing.x).name', expected: undefined },
    { expr: 'first(table).constructor', expected: undefined },                   // own properties only
    // list functions: map/filter/some/every read the item as `it`
    { expr: 'map(table, it.bank)', expected: ['ING', 'ABN | AMRO'] },
    { expr: 'filter(table, it.ratio > 1)', expected: [{ bank: 'ING', ratio: 1.2 }] },
    { expr: 'some(item.tags, it == "y")', expected: true },
    { expr: 'every(item.tags, len(it) == 1)', expected: true },
    { expr: 'every(mail.none, true)', expected: false },                        // like everyOf: an empty list is false
    { expr: 'some(mail.none, true)', expected: false },
    { expr: 'map(missing.x, it)', expected: [] },
    { expr: 'map(table, filter(item.tags, it != "x"))', expected: [['y'], ['y']] },   // nested: the inner it is the tag
    { expr: 'join(map(filter(mail.attachments, endsWith(it.filename, ".pdf")), upper(it.filename)), ";")', expected: 'FACTUUR.PDF' },
    { expr: 'sum(parseJson(rawJson, "items"), "qty")', expected: 2 },
    { expr: 'sum(map(table, it.ratio * 10))', expected: 21 },
    { expr: 'unique(split("a,b,a", ","))', expected: ['a', 'b'] },
    { expr: 'unique(table, "bank")', expected: [{ bank: 'ING', ratio: 1.2 }, { bank: 'ABN | AMRO', ratio: 0.9, note: 'x' }] },
    // regular expressions (pattern and flags are literals)
    { expr: 'regexMatch(form.email, "^[a-z]+@[a-z]+[.]com$")', expected: true },
    { expr: 'regexMatch(currentUser.name, "^tom$", "i")', expected: true },
    { expr: 'regexMatch("ab12", "^[a-z]+\\d+$")', expected: true },        // \d is a digit class, not the letter d
    { expr: 'regexMatch("a b", "a\\sb")', expected: true },
    { expr: 'regexMatch("say \\"hi\\"", "\\"hi\\"")', expected: true },   // an escaped quote stays a quote
    { expr: 'regexMatch(missing.x, "a")', expected: false },
    { expr: 'regexReplace("2026-07-04", "([0-9]+)-([0-9]+)-([0-9]+)", "$3/$2/$1")', expected: '04/07/2026' },
    { expr: 'regexReplace("a1b22", "[0-9]+", "<$&>")', expected: 'a<1>b<22>' },
    { expr: 'regexReplace("Total", "t", "$$", "i")', expected: '$o$al' },
    ...COLLECTION_CASES,
];

// Expressions that MUST throw at parse time.
export const LIST_REJECT = [
    'first(item.tags)()',                       // a call result is not callable
    'map(item.tags)',                           // a list function needs its expression
    'map(item.tags, it, 1)',
    'regexMatch(form.email, form.email)',       // the pattern must be a literal
    'regexMatch(form.email, "a", form.email)',  // so must the flags
    'regexMatch(form.email, "(a+)+")',          // nested quantifier
    'regexMatch(form.email, "(\\w|\\d)+x")',      // alternative inside a repeated group
    'regexMatch(form.email, "(a|aa)+$")',
    'regexMatch(form.email, "(?=a)")',          // look-ahead
    'regexMatch(form.email, "(?<!a)b")',        // look-behind
    'regexMatch(form.email, "(a)\\1")',          // back-reference
    'regexMatch(form.email, "a", "g")',         // unknown flag
    'regexMatch(form.email, "[")',              // not a pattern
    'regexReplace(form.email, "a", "b", "i", 1)',
    ...COLLECTION_REJECT,
];
