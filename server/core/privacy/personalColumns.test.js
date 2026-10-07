/**
 * The ONE personal-data column detector: names, values, and the count behind
 * the values.
 *
 * What these tests hold in place is mostly the difference between three
 * answers that look alike and are not: "the guard read this column and it was
 * clean", "the guard cannot read this column", "the guard flagged it but could
 * not say where". Each of them used to collapse into one of the others
 * somewhere, and each collapse ended with a review claiming something nobody
 * had checked.
 *
 * Run: node --test --test-force-exit core/privacy/personalColumns.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./personalColumns');
const { CANONICAL_IDS } = require('./piiCategories');

const FIELDS = [
    { key: 'supplier', name: 'Leverancier', type: 'text' },
    { key: 'notes', name: 'Notes', type: 'text' },
    { key: 'total', name: 'Total', type: 'number' },
];
/** A guard that reports WHERE it found what it found, as the real one does. */
const guardFor = (re, category) => async (text) => ({
    hasPii: true,
    entities: [...text.matchAll(re)].map((m) => ({ category, text: m[0], offset: m.index, length: m[0].length })),
});
const EMAIL_GUARD = guardFor(/\S+@\S+/g, 'Email');

test('the names read as personal data in the languages we ship', () => {
    const out = P.byName([{ key: 'achternaam', name: 'Achternaam' }, { key: 'iban', name: 'IBAN' }, { key: 'total', name: 'Total' }]);
    assert.deepEqual(out.map((c) => [c.key, c.kind]), [['achternaam', 'name'], ['iban', 'financial']]);
    // A name is not a count: nothing read a single value here, and the entry
    // says so rather than reporting zero matches out of zero cells.
    assert.equal(out[0].by, 'names');
    assert.equal(out[0].matched, null);
    assert.equal(out[0].confidence, 'name_only');
    assert.deepEqual(P.byName(null), []);
});

test('snake_case and camelCase names read as the words they were written from', () => {
    // The patterns are \b-anchored, and an underscore or a camel hump is no
    // word boundary: these keys all came back "no personal data".
    assert.equal(P.kindFromName({ key: 'email_address' }), 'email');
    assert.equal(P.kindFromName({ key: 'first_name', name: 'first_name' }), 'name');
    assert.equal(P.kindFromName({ key: 'phoneNumber' }), 'phone');
    // The patterns written with the underscore still match the raw key.
    assert.equal(P.kindFromName({ key: 'id_number' }), 'id_number');
    assert.equal(P.kindFromName({ key: 'account_number' }), 'financial');
    // A word inside another word is still not that word.
    assert.equal(P.kindFromName({ key: 'page_count' }), null);
    assert.equal(P.kindFromName({ key: 'username' }), null);
});

test('every canonical guard category is either a kind of personal data or listed as not one', () => {
    // The old private map keyed on the category squashed to snake_case, which
    // no canonical id is — so 'PhoneNumber' matched nothing and a column of
    // telephone numbers read as clean. An id that nobody maps is not allowed
    // to fail silently again: add it to KIND_OF_CATEGORY, or say out loud in
    // NOT_PERSONAL_CATEGORIES that it is not personal data by itself.
    const unmapped = CANONICAL_IDS.filter((id) => !P.KIND_OF_CATEGORY[id] && !P.NOT_PERSONAL_CATEGORIES.includes(id));
    assert.deepEqual(unmapped, [], `unmapped guard categories: ${unmapped.join(', ')}`);
    // And every kind it maps to is one of our words.
    for (const kind of Object.values(P.KIND_OF_CATEGORY)) assert.ok(P.KINDS.includes(kind), `unknown kind ${kind}`);
});

test('a category is understood in every spelling a producer has ever written', () => {
    for (const spelling of ['PhoneNumber', 'phone_number', 'phone number', 'PHONE']) {
        assert.equal(P.kindOfCategory(spelling), 'phone', spelling);
    }
    assert.equal(P.kindOfCategory('national id (BSN / DNI / …)'), 'id_number');
    assert.equal(P.kindOfCategory('wingspan'), null, 'an unknown category is not invented into a kind');
    // A company name is not personal data — this is the case the value scan
    // exists for: a column called "supplier" full of company names.
    assert.equal(P.kindOfCategory('Organization'), null);
});

test('the cells of a column are sampled whole, and one long cell cannot become the whole sample', async () => {
    const rows = [{ notes: 'x'.repeat(900) }, { notes: 'jan@acme.nl' }, { notes: '' }, { notes: '   ' }];
    const { cells, blob } = P.sampleCells(rows, 'notes', { sampleChars: 1000 });
    assert.equal(cells.length, 2, 'the empty and blank cells were not looked at, so they are not in the denominator');
    assert.equal(cells[0].value.length, P.MAX_CELL_CHARS, 'a 900-character note is cut so the other cells still fit');
    assert.equal(blob.slice(cells[1].start, cells[1].end), 'jan@acme.nl', 'and every cell knows where it sits in the blob');
});

test('the value scan counts CELLS, over one guard call per column', async () => {
    // One stray address in a notes column read exactly like a column of two
    // hundred addresses, because every value was joined into one blob and the
    // guard was asked once: a yes with no denominator. The blob stays (the
    // guard is a CPU-only sidecar and a call per cell would be fifty per
    // column) — the offsets it already returns do the counting.
    let calls = 0;
    const rows = [{ notes: 'mail jan@acme.nl' }, ...Array.from({ length: 9 }, () => ({ notes: 'nothing here' }))];
    const scan = async (t) => { calls += 1; return EMAIL_GUARD(t); };
    const out = await P.byValue({ fields: [{ key: 'notes', name: 'Notes', type: 'text' }], rows }, { scan });
    assert.equal(calls, 1, 'one call for the column, not one per cell');
    assert.deepEqual(out.scanned, ['notes']);
    assert.equal(out.columns[0].sampled, 10);
    assert.equal(out.columns[0].matched, 1);
    assert.deepEqual(out.columns[0].byKind, { email: 1 });
    assert.equal(out.columns[0].rate, 0.1);
    assert.equal(out.columns[0].confidence, 'incidental', 'a stray value in free text is not what the column is for');
});

test('a guard that says WHAT it matched but not where is still counted, by the text', () => {
    const cells = P.sampleCells([{ c: 'bel 06-12345678' }, { c: 'niets' }, { c: 'ook 06-12345678' }], 'c').cells;
    const weighed = P.weighColumn(cells, [{ category: 'PhoneNumber', text: '06-12345678' }], null);
    assert.equal(weighed.matched, 2, 'both cells hold the value the guard matched');
    assert.deepEqual(weighed.byKind, { phone: 2 });
});

test('a guard that says NEITHER leaves the count unknown — never zero', () => {
    // Zero would read as "looked in every cell and found nothing", which is
    // the opposite of what happened.
    const cells = P.sampleCells([{ c: 'jan@acme.nl' }], 'c').cells;
    const weighed = P.weighColumn(cells, [{ category: 'Email' }], null);
    assert.deepEqual(weighed.kinds, ['email'], 'the column is still flagged');
    assert.equal(weighed.matched, null);
    assert.equal(weighed.byKind, null);
    assert.equal(weighed.rate, null);
    assert.equal(weighed.confidence, 'unweighed');
});

test('the column NAME anchors the values: agreement confirms, silence gets weighed', async () => {
    // Macie's column-name anchor, which this code had both halves of and used
    // neither on the other: the names were consulted ONLY when the values were
    // unavailable.
    const rows = Array.from({ length: 10 }, (_, i) => ({ email: `klant${i}@acme.nl`, notes: i === 0 ? 'mail piet@acme.nl' : 'niets' }));
    const fields = [{ key: 'email', name: 'E-mail', type: 'text' }, { key: 'notes', name: 'Notes', type: 'text' }];
    const { columns } = await P.byValue({ fields, rows }, { scan: EMAIL_GUARD });
    const named = columns.find((c) => c.key === 'email');
    const free = columns.find((c) => c.key === 'notes');
    assert.equal(named.confidence, 'confirmed', 'the name says e-mail and the values are e-mail addresses');
    assert.equal(free.confidence, 'incidental', 'one address in a column called Notes is a mention, not a column of addresses');
    // Same kind, same guard, same call count — only the weight differs.
    assert.deepEqual([named.kind, free.kind], ['email', 'email']);
});

test('an anchored kind leads the list, so the ONE kind a consumer shows is the right one', () => {
    const cells = P.sampleCells([{ c: 'Jan de Vries jan@acme.nl' }], 'c').cells;
    const both = [{ category: 'Person', text: 'Jan de Vries' }, { category: 'Email', text: 'jan@acme.nl' }];
    assert.deepEqual(P.weighColumn(cells, both, 'email').kinds, ['email', 'name'], 'the column is called e-mail');
    assert.deepEqual(P.weighColumn(cells, both, null).kinds, ['name', 'email'], 'and without a name to go on, our own reading order');
    // A "klant"/"customer" column is where person names live, so it vouches
    // for them — while a company name in it is still not personal data,
    // because the guard reports that as Organization and nothing maps it.
    assert.deepEqual(P.anchorsFor('supplier'), ['supplier', 'name']);
    assert.equal(P.weighColumn(cells, [{ category: 'Person', text: 'Jan de Vries' }], 'supplier').confidence, 'confirmed');
});

test('no guard is no answer, and an answer of nothing is an answer', async () => {
    const rows = [{ supplier: 'ACME B.V.', notes: 'niets' }];
    // Not installed, could not scan, threw — none of the three may read as a
    // clean table.
    assert.equal(await P.byValue({ fields: FIELDS, rows }, { scan: async () => null }), null);
    assert.equal(await P.byValue({ fields: FIELDS, rows }, { scan: async () => ({ entities: [], degraded: true }) }), null);
    assert.equal(await P.byValue({ fields: FIELDS, rows }, { scan: async () => { throw new Error('down'); } }), null);
    assert.equal(await P.byValue({ fields: FIELDS, rows }, {}), null, 'and no guard to call at all');
    assert.equal(await P.byValue({ fields: FIELDS, rows: [] }, { scan: EMAIL_GUARD }), null, 'nothing to scan is no answer either');
    // A guard that looked and found nothing IS an answer: no columns, and the
    // two columns it read.
    const clean = await P.byValue({ fields: FIELDS, rows }, { scan: async () => ({ hasPii: false, entities: [] }) });
    assert.deepEqual(clean, { columns: [], scanned: ['supplier', 'notes'] });
});

test('only the columns whose values can be read are handed to the guard', async () => {
    const seen = [];
    const rows = [{ supplier: 'ACME B.V.', notes: 'jan@acme.nl', total: 10 }];
    await P.byValue({ fields: FIELDS, rows }, { scan: async (t) => { seen.push(t); return EMAIL_GUARD(t); } });
    assert.equal(seen.length, 2, 'text and richtext only — never the numbers');
    assert.ok(!seen.join('').includes('10'));
});

test('values win where they were read, names answer where they could not be', () => {
    const fields = [
        { key: 'notes', name: 'Notes', type: 'text' },
        { key: 'leverancier', name: 'Leverancier', type: 'text' },
        { key: 'dob', name: 'Geboorte datum', type: 'date' },
    ];
    const values = [{ key: 'notes', name: 'Notes', kinds: ['email'], by: 'values' }];
    const merged = P.mergeDetections({ fields, byValue: values, scanned: ['notes', 'leverancier'] });
    assert.equal(merged.method, 'values');
    assert.deepEqual(merged.columns.map((c) => [c.key, c.by]), [['notes', 'values'], ['dob', 'names']]);
    // The supplier column was READ and was clean — its name does not get to
    // override that. This is the distinction the value scan exists for.
    assert.ok(!merged.columns.some((c) => c.key === 'leverancier'));
    // No value answer at all → the names speak for the whole table.
    const byNames = P.mergeDetections({ fields, byValue: null });
    assert.equal(byNames.method, 'names');
    assert.deepEqual(byNames.columns.map((c) => c.key), ['leverancier', 'dob']);
    // A value answer that does not say what it read keeps the old behaviour:
    // the values answered for everything. The other assumption would bring
    // the cleared supplier column straight back.
    const silent = P.mergeDetections({ fields, byValue: values });
    assert.deepEqual(silent.columns.map((c) => c.key), ['notes']);
});

test('every entry comes out in one shape, whatever era it was written in', () => {
    const [entry] = P.mergeDetections({ fields: [], byValue: [{ key: 'notes', name: 'Notes', kinds: ['email', 'phone'] }] }).columns;
    assert.deepEqual(entry, {
        key: 'notes', name: 'Notes', kind: 'email', kinds: ['email', 'phone'], by: 'values',
        nameKind: null, sampled: null, matched: null, byKind: null, rate: null, confidence: 'unweighed',
    });
    // A hit with no kind at all still names itself something a person can read.
    assert.equal(P.normaliseEntry({ key: 'x' }).kind, 'personal');
});
