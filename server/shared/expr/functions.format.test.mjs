/**
 * The formatting helpers behind the builder's "· as € 1.500.000" pills
 * (builder redesign, artboard 2c). Run from server/:
 *   node --test shared/expr/functions.format.test.mjs
 *
 * Two properties matter more than any single output. They are DETERMINISTIC
 * — locale is an argument, never Intl, so Node and the browser agree byte for
 * byte (sharedExpr.sync.test.js pins the two copies identical). And they are
 * TOTAL — a missing or non-numeric value gives '' (a clean text slot), never
 * "NaN", "undefined" or "[object Object]" pasted into an email.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FUNCTIONS, EXPR_FUNCTIONS, EXPR_FUNCTION_NAMES } from './functions.mjs';
import { evaluate } from './engine.mjs';

const { formatNumber, formatDate, yesNoText, groupSummary, asTable } = FUNCTIONS;

test('formatNumber — amount / percent / plain, in the design locale', () => {
    assert.equal(formatNumber(1500000, 'amount'), '€ 1.500.000');      // the artboard's pill
    assert.equal(formatNumber(1500000, 'amount', 'nl'), '€ 1.500.000');
    assert.equal(formatNumber(12.5, 'amount'), '€ 12,50');             // cents only when there are any
    assert.equal(formatNumber(-12.5, 'amount'), '-€ 12,50');
    assert.equal(formatNumber(0.125, 'percent'), '12,5%');            // the value is the fraction
    assert.equal(formatNumber(1, 'percent'), '100%');
    assert.equal(formatNumber(1500000, 'plain'), '1.500.000');
    assert.equal(formatNumber('1234.5'), '1.234,5');                  // strings that are numbers count
    assert.equal(formatNumber(1234.5678, 'plain', 'nl', 2), '1.234,57');
    assert.equal(formatNumber(1234, 'amount', 'nl', 2), '€ 1.234,00');
});

test('formatNumber — the locale table, not Intl', () => {
    assert.equal(formatNumber(1500000, 'amount', 'en'), '€1,500,000');
    assert.equal(formatNumber(1500000.5, 'plain', 'en'), '1,500,000.5');
    assert.equal(formatNumber(1500000, 'amount', 'de'), '1.500.000 €');
    assert.equal(formatNumber(0.125, 'percent', 'de'), '12,5 %');
    assert.equal(formatNumber(1500000, 'amount', 'fr'), '1 500 000 €');
    assert.equal(formatNumber(1500000, 'amount', 'nl-NL'), '€ 1.500.000');
    assert.equal(formatNumber(1500000, 'amount', 'xx'), '€ 1.500.000'); // unknown → the design language
});

test('formatNumber — total: nothing numeric gives an empty string, never NaN', () => {
    assert.equal(formatNumber(null, 'amount'), '');
    assert.equal(formatNumber(undefined), '');
    assert.equal(formatNumber('twelve', 'amount'), '');
    assert.equal(formatNumber({}, 'plain'), '');
    assert.equal(formatNumber(Infinity, 'plain'), '');
    assert.equal(formatNumber(1e308, 'percent'), '');                 // ×100 overflows → ''
    assert.equal(formatNumber(5, 'nonsense'), '5');                    // unknown style reads as plain
});

test('formatDate — month names, weekday names and unpadded day/month', () => {
    assert.equal(formatDate('2026-09-02', 'D MMMM YYYY'), '2 september 2026');   // artboard 2c
    assert.equal(formatDate('2026-09-02', 'DD-MM-YYYY'), '02-09-2026');           // artboard 2c
    assert.equal(formatDate('2026-09-02', 'D MMMM YYYY', 'en'), '2 September 2026');
    assert.equal(formatDate('2026-09-02', 'dddd D MMM', 'nl'), 'woensdag 2 sep');
    assert.equal(formatDate('2026-09-02', 'ddd D/M', 'en'), 'We 2/9');
    assert.equal(formatDate('2026-09-02T10:26:05Z', 'D MMMM YYYY, HH:mm', 'de'), '2 September 2026, 10:26');
    assert.equal(formatDate('2026-09-02', 'D MMMM YYYY', 'fr'), '2 septembre 2026');
    // A second month per language, because pinning only 'september' leaves
    // eleven table entries a mutation can quietly rewrite (measured: turning
    // 'januari' into 'MUTANT' left this test green).
    assert.equal(formatDate('2026-01-15', 'D MMMM YYYY'), '15 januari 2026');
    assert.equal(formatDate('2026-01-15', 'D MMMM YYYY', 'en'), '15 January 2026');
    assert.equal(formatDate('2026-01-15', 'D MMMM YYYY', 'de'), '15 Januar 2026');
    assert.equal(formatDate('2026-01-15', 'D MMMM YYYY', 'fr'), '15 janvier 2026');
    assert.equal(formatDate('2026-01-15', 'dddd', 'nl'), 'donderdag');
});

test('formatDate — the six original tokens are byte-identical to before', () => {
    assert.equal(formatDate('2026-07-04T12:00:00Z', 'YYYY-MM-DD'), '2026-07-04');
    assert.equal(formatDate('2026-07-04T12:00:00Z', 'HH:mm'), '12:00');
    assert.equal(formatDate('2026-07-04T12:34:56Z', 'YYYY-MM-DD HH:mm:ss'), '2026-07-04 12:34:56');
    assert.equal(formatDate('2026-07-04'), '2026-07-04');                // default format unchanged
    assert.equal(formatDate(null, 'D MMMM YYYY'), '');
    assert.equal(formatDate('not a date', 'D MMMM YYYY'), '');
});

test('yesNoText — the words for each state, silent when undecidable', () => {
    assert.equal(yesNoText(true, 'wel', 'niet'), 'wel');
    assert.equal(yesNoText(false, 'wel', 'niet'), 'niet');
    assert.equal(yesNoText('ja', 'wel', 'niet'), 'wel');
    assert.equal(yesNoText('No', 'wel', 'niet'), 'niet');
    assert.equal(yesNoText(1, 'wel', 'niet'), 'wel');
    assert.equal(yesNoText(0, 'wel', 'niet'), 'niet');
    assert.equal(yesNoText(true), 'yes');
    assert.equal(yesNoText(false), 'no');
    assert.equal(yesNoText(null, 'wel', 'niet'), '');
    assert.equal(yesNoText('maybe', 'wel', 'niet'), '');
});

test('groupSummary — one readable line per field, never [object Object]', () => {
    const group = { customer_name: 'Alice', amount: 1500000, tags: ['a', 'b'], address: { city: 'Delft', zip: '2611' } };
    assert.equal(groupSummary(group), 'Customer name: Alice\nAmount: 1500000\nTags: a, b\nAddress: City: Delft, Zip: 2611');
    assert.equal(groupSummary([{ a: 1 }, { a: 2 }]), 'A: 1\n\nA: 2');
    assert.equal(groupSummary('text'), 'text');
    assert.equal(groupSummary(null), '');
    assert.ok(!groupSummary({ a: { b: { c: { d: 1 } } } }).includes('[object'));
});

test('asTable — a Markdown table, header in first-seen order, pipes escaped', () => {
    const rows = [{ bank: 'ING', ratio: 1.2 }, { bank: 'ABN | AMRO', ratio: 0.9, note: 'x' }];
    assert.equal(asTable(rows), [
        '| Bank | Ratio | Note |',
        '| --- | --- | --- |',
        '| ING | 1.2 |  |',
        '| ABN \\| AMRO | 0.9 | x |',
    ].join('\n'));
    assert.equal(asTable(['a', 'b']), '| value |\n| --- |\n| a |\n| b |');
    assert.equal(asTable([]), '');
    assert.equal(asTable(null), '');
    assert.equal(asTable('text'), '');
});

test('the five helpers are callable from an expression and documented for the help panel', () => {
    const scope = { steps: { s1: { output: { amount: 1500000, when: '2026-09-02', paid: true, rows: [{ a: 1 }], group: { a: 1 } } } } };
    assert.equal(evaluate('formatNumber(steps.s1.output.amount, "amount", "nl")', scope), '€ 1.500.000');
    assert.equal(evaluate('formatDate(steps.s1.output.when, "D MMMM YYYY", "nl")', scope), '2 september 2026');
    assert.equal(evaluate('yesNoText(steps.s1.output.paid, "wel", "niet")', scope), 'wel');
    assert.equal(evaluate('asTable(steps.s1.output.rows)', scope), '| A |\n| --- |\n| 1 |');
    assert.equal(evaluate('groupSummary(steps.s1.output.group)', scope), 'A: 1');
    for (const name of ['formatNumber', 'formatDate', 'yesNoText', 'groupSummary', 'asTable']) {
        assert.ok(EXPR_FUNCTION_NAMES.includes(name), `${name} is whitelisted`);
        assert.ok(EXPR_FUNCTIONS.some((f) => f.name === name), `${name} has a help entry`);
    }
});

test('formatDate is TOTAL over numbers — a nanosecond epoch does not throw', () => {
    // The regression this pins: MMMM/dddd index a month/weekday TABLE, and a
    // Date built from an out-of-range number reads NaN for every getUTC*, so
    // the lookup was `undefined.slice(0, 3)` — a bare TypeError thrown out of
    // a file whose header promises "never throws … returns a benign fallback".
    // The map is built eagerly, so even a format with no name token threw.
    //
    // It is not an exotic input: nanosecond epochs (Prometheus, Kubernetes,
    // Cassandra, plenty of webhooks) arrive through an HTTP step routinely,
    // and 1.76e18 is a perfectly finite number. Measured consequences of the
    // throw: the whole expression resolved to undefined (a silently empty
    // field), execCondition put the raw JS text "Cannot read properties of
    // undefined" in the user-visible output, and a trigger filter swallowed
    // the event.
    const NS = 1757376000000000000;                    // 2025-09-09 in NANOseconds
    assert.equal(formatDate(NS, 'D MMMM YYYY', 'nl'), '');
    assert.equal(formatDate(NS, 'YYYY-MM-DD'), '');    // no name token, same answer
    assert.equal(formatDate(-NS, 'D MMMM YYYY'), '');
    assert.equal(formatDate(1e20, 'dddd'), '');
    assert.equal(formatDate(NaN, 'D MMMM YYYY'), '');
    assert.equal(formatDate(Infinity, 'D MMMM YYYY'), '');
    // The same instant in MILLIseconds is a date, and still reads as one.
    assert.equal(formatDate(1757376000000, 'D MMMM YYYY', 'nl'), '9 september 2025');
    // The exact edge: 8.64e15 is the widest instant a Date holds; one more is not.
    assert.equal(formatDate(8.64e15, 'YYYY-MM-DD'), '275760-09-13');
    assert.equal(formatDate(8.64e15 + 1, 'YYYY-MM-DD'), '');
    // Every other date reader shares toEpoch, so none of them may throw either.
    assert.equal(FUNCTIONS.year(NS), null);
    assert.equal(FUNCTIONS.month(NS), null);
    assert.equal(FUNCTIONS.weekday(NS), null);
    assert.equal(FUNCTIONS.dateAdd(NS, 1, 'day'), null);
    assert.equal(FUNCTIONS.dateDiff(NS, '2026-01-01', 'day'), null);
    assert.equal(FUNCTIONS.isBefore(NS, '2026-01-01'), false);
});

test('a date is read in UTC or not at all — no ambient timezone, ever', () => {
    // The header's determinism promise, tested where it used to leak. Anything
    // the two strict shapes did not match fell through to `Date.parse`, which
    // reads a zone-less date in the LOCAL zone: '2026-9-2' was 2 september on
    // a UTC server and 1 september in a browser in Amsterdam. That is the
    // builder's preview and the run it previews disagreeing by a day, on the
    // same data — and neither guard test could see it (sharedExpr.sync
    // compares BYTES, sharedExpr.parity runs both copies in ONE process with
    // ONE zone).
    //
    // The two answers now: read it as that UTC day, or do not read it.
    assert.equal(formatDate('2026-9-2', 'D MMMM YYYY', 'nl'), '2 september 2026');
    assert.equal(formatDate('2026/09/02', 'D MMMM YYYY', 'nl'), '2 september 2026');
    assert.equal(formatDate('2026/9/2', 'DD-MM-YYYY'), '02-09-2026');
    assert.equal(formatDate('2026-9-2 7:05', 'HH:mm'), '07:05');
    assert.equal(formatDate('2026-9-2T07:05:00Z', 'D MMMM YYYY HH:mm', 'nl'), '2 september 2026 07:05');
    // …and prose, whose Date.parse result is ENGINE-defined (V8 and
    // JavaScriptCore need not agree at all), is simply not a date here — the
    // same '' that 'not a date' has always given.
    assert.equal(formatDate('Sep 2, 2026', 'D MMMM YYYY'), '');
    assert.equal(formatDate('2 September 2026', 'D MMMM YYYY'), '');
    assert.equal(formatDate('September 2, 2026 10:00', 'D MMMM YYYY'), '');
    assert.equal(FUNCTIONS.isBefore('Sep 2, 2026', '2026-09-03'), false);
    assert.equal(FUNCTIONS.year('Sep 2, 2026'), null);

    // The bite, in one assertion: the strict AND the newly-accepted shapes
    // must give the same answer under a zone that is not UTC. `Date.parse`
    // would return a different DAY here; a UTC-only reading cannot.
    const before = process.env.TZ;
    try {
        for (const zone of ['UTC', 'Europe/Amsterdam', 'Pacific/Auckland']) {
            process.env.TZ = zone;
            assert.equal(formatDate('2026-9-2', 'D MMMM YYYY HH:mm', 'nl'), '2 september 2026 00:00', zone);
            assert.equal(formatDate('2026-09-02', 'D MMMM YYYY HH:mm', 'nl'), '2 september 2026 00:00', zone);
        }
    } finally {
        if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
    }
});
