/**
 * The "Only mail matching" query on an Outlook mailbox: category terms become a
 * categories $filter, everything else goes verbatim to $search.
 *
 * Run: cd server && node --test core/integrations/outlookQuery.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { planOutlookQuery, outlookListQuery, MailboxQueryError } = require('./outlookQuery.mts');

const SINCE = '2026-11-01T00:00:00.000Z';
const decode = (qs) => Object.fromEntries(new URLSearchParams(qs.replace(/%20/g, '+')));
const list = (query, sinceIso = SINCE) => outlookListQuery({ query, sinceIso, select: 'id', top: 50 });
const params = (query, sinceIso) => decode(list(query, sinceIso).qs);

test('two quoted categories with OR: one $filter with the date, no $search', () => {
    const p = params('category:"INKOOPORDERS" OR category:"TEST OFFERTES"');
    assert.strictEqual(p.$filter, `lastModifiedDateTime ge ${SINCE} and (categories/any(c:c eq 'INKOOPORDERS') or categories/any(c:c eq 'TEST OFFERTES'))`);
    assert.strictEqual(p.$orderby, 'lastModifiedDateTime desc');
    assert.strictEqual(p.$search, undefined);
    assert.ok(!list('category:a OR category:b').qs.includes('+'), 'spaces travel as %20');
});

test('without a date the OR needs no parentheses', () => {
    const p = params('category:a OR category:b', null);
    assert.strictEqual(p.$filter, "categories/any(c:c eq 'a') or categories/any(c:c eq 'b')");
    assert.strictEqual(p.$orderby, 'receivedDateTime desc');
});

test('category:x, label:x, label:"x" and any case name the same category', () => {
    const want = params('category:Spoed', null).$filter;
    assert.strictEqual(want, "categories/any(c:c eq 'Spoed')");
    for (const q of ['label:Spoed', 'Category:Spoed', 'LABEL:"Spoed"', 'category:"Spoed"']) {
        assert.strictEqual(params(q, null).$filter, want, q);
    }
    assert.strictEqual(params('label:"Daniel B"', null).$filter, "categories/any(c:c eq 'Daniel B')");
});

test('parentheses, explicit AND and adjacency', () => {
    const want = "(categories/any(c:c eq 'A') or categories/any(c:c eq 'B')) and categories/any(c:c eq 'C D')";
    assert.strictEqual(params('(category:"A" OR category:B) AND label:"C D"', null).$filter, want);
    assert.strictEqual(params('(category:"A" OR category:B) label:"C D"', null).$filter, want);
    assert.strictEqual(params('category:a category:b', null).$filter, "categories/any(c:c eq 'a') and categories/any(c:c eq 'b')");
    assert.strictEqual(params('category:a OR category:b category:c', null).$filter,
        "categories/any(c:c eq 'a') or categories/any(c:c eq 'b') and categories/any(c:c eq 'c')");
});

test('a quote in a category name is escaped', () => {
    assert.strictEqual(params(`category:"O'Neill"`, null).$filter, "categories/any(c:c eq 'O''Neill')");
});

test('text only goes to $search unchanged: no filter, no order, no date', () => {
    const p = params('from:klant.nl hasattachments:true received>=2026-01-01 OR (subject:"a b" NOT draft)');
    assert.strictEqual(p.$search, '"from:klant.nl hasattachments:true received>=2026-01-01 OR (subject:a b NOT draft)"');
    assert.strictEqual(p.$filter, undefined);
    assert.strictEqual(p.$orderby, undefined);
});

test('text plus categories: verbatim text in $search, the category tree is applied to the results', () => {
    const { qs, matches } = list('from:klant.nl AND (category:A OR category:"B c") hasattachments:true');
    const p = decode(qs);
    assert.strictEqual(p.$search, '"from:klant.nl AND hasattachments:true"');
    assert.strictEqual(p.$filter, undefined);
    assert.strictEqual(matches(['a']), true);
    assert.strictEqual(matches('Other, b C'), true, 'case-insensitive, comma list');
    assert.strictEqual(matches(['zzz']), false);
    assert.strictEqual(matches([]), false);
});

test('text plus categories joined by AND: every category conjunct must hold', () => {
    const { matches } = list('offerte category:a category:b');
    assert.strictEqual(matches(['A', 'B']), true);
    assert.strictEqual(matches(['A']), false);
});

test('NOT on a category works with text (checked here) and is refused for the $filter', () => {
    const { matches } = list('offerte NOT category:spam');
    assert.strictEqual(matches(['Spam']), false);
    assert.strictEqual(matches(['ok']), true);
    assert.strictEqual(list('offerte -label:spam').matches(['SPAM']), false);
    assert.throws(() => list('NOT category:spam'), (e) => e instanceof MailboxQueryError && /NOT on a category/.test(e.message));
});

test('a category mixed with other terms under OR cannot be split: a clear error', () => {
    for (const q of ['category:A OR from:x', 'NOT (category:A from:x)']) {
        assert.throws(() => planOutlookQuery(q), (e) => e instanceof MailboxQueryError
            && e.status === 422 && e.code === 'mailbox_query_invalid'
            && /category: can only be combined with other search terms by AND/.test(e.message));
    }
    assert.throws(() => planOutlookQuery('category:A OR from:x'), /`category:A OR from:x` mixes them/);
});

test('syntax errors around categories are refused, without categories Graph judges', () => {
    assert.throws(() => planOutlookQuery('(category:a'), MailboxQueryError);
    assert.throws(() => planOutlookQuery('category:a)'), MailboxQueryError);
    assert.throws(() => planOutlookQuery('category:a OR'), MailboxQueryError);
    assert.throws(() => planOutlookQuery('category:'), /needs a category name/);
    assert.strictEqual(planOutlookQuery('from:x OR').text, 'from:x OR');
});

test('from:(a OR b) stays one term', () => {
    const plan = planOutlookQuery('category:a from:(x OR y)');
    assert.strictEqual(plan.text, 'from:(x OR y)');
});

test('a since filters on the MODIFIED time (a late category bumps it), ordered by the same property', () => {
    const p = params('', SINCE);
    assert.strictEqual(p.$filter, `lastModifiedDateTime ge ${SINCE}`);
    assert.strictEqual(p.$orderby, 'lastModifiedDateTime desc');
});

test('a bare word is a $search, an empty query matches everything', () => {
    assert.strictEqual(params('factuur').$search, '"factuur"');
    assert.strictEqual(list('').matches(['x']), true);
});
