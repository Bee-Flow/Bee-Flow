/**
 * The IO half of the review. Every read here replaces a guess, and every one
 * of them has to degrade without lying: no guard is "ask the names", not "no
 * personal data".
 *
 * Run: node --test --test-force-exit playbooks/phases/complianceFacts.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./complianceFacts');

const FIELDS = [
    { key: 'supplier', name: 'Leverancier', type: 'text' },
    { key: 'notes', name: 'Notes', type: 'text' },
    { key: 'total', name: 'Total', type: 'number' },
];
const ROWS = [
    { supplier: 'ACME B.V.', notes: 'mail jan@acme.nl about this', total: 10 },
    { supplier: 'Globex', notes: 'called 06-12345678', total: 20 },
];

test('the guard reads the VALUES: a company column is clean, a notes column is not', async () => {
    const seen = [];
    const deps = {
        detectPii: async (text) => {
            seen.push(text);
            return /@|06-/.test(text)
                ? { hasPii: true, entities: [{ category: 'EMAIL' }, { category: 'phone_number' }] }
                : { hasPii: false, entities: [] };
        },
    };
    const out = await F.personalColumnsByValue({ fields: FIELDS, rows: ROWS }, deps);
    assert.deepEqual(out, [{
        key: 'notes', name: 'Notes', kind: 'email', kinds: ['email', 'phone'], by: 'values', nameKind: null,
        // This stub answers the way the guard does when it reports a category
        // and nothing else — no offset, no matched text. Then the column is
        // flagged and the COUNT is unknown: `matched: null`, never 0, because
        // a 0 here would read as "the guard looked in every cell and found
        // nothing" while it in fact found something it could not place.
        sampled: 2, matched: null, byKind: null, rate: null, confidence: 'unweighed',
    }]);
    assert.equal(seen.length, 2, 'only the text columns are scanned — never the numbers');
    assert.ok(!seen.join('').includes('10'), 'and never a column it was not asked about');
});

test('the column says HOW MUCH of it is personal data, not just that it is', async () => {
    // One stray e-mail address in a notes column used to read exactly like a
    // column of nothing but e-mail addresses: every value was joined into one
    // blob and the guard was asked once, so the answer was a yes with no
    // denominator behind it. A reviewer could not tell the two apart, and the
    // first one is a note somebody typed while the second one is a mailing
    // list. Now the cells are counted.
    const rows = [
        { notes: 'mail jan@acme.nl about this' },
        ...Array.from({ length: 9 }, () => ({ notes: 'nothing to report' })),
    ];
    // The real guard reports where it found the value; the offsets are what
    // lets ONE request per column answer "in how many cells".
    const guard = async (text) => {
        const at = text.indexOf('jan@acme.nl');
        return { hasPii: true, entities: at < 0 ? [] : [{ category: 'Email', text: 'jan@acme.nl', offset: at, length: 11 }] };
    };
    const [col] = await F.personalColumnsByValue({ fields: [{ key: 'notes', name: 'Notes', type: 'text' }], rows }, { detectPii: guard });
    assert.equal(col.sampled, 10, 'ten filled cells were handed to the guard');
    assert.equal(col.matched, 1, 'one of them held personal data');
    assert.deepEqual(col.byKind, { email: 1 });
    assert.equal(col.rate, 0.1);

    // The same column, but this is what it is FOR: every cell is an address.
    const many = Array.from({ length: 10 }, (_, i) => ({ notes: `klant${i}@acme.nl` }));
    const all = async (text) => ({
        hasPii: true,
        entities: [...text.matchAll(/\S+@\S+/g)].map((m) => ({ category: 'Email', text: m[0], offset: m.index, length: m[0].length })),
    });
    const [busy] = await F.personalColumnsByValue({ fields: [{ key: 'notes', name: 'Notes', type: 'text' }], rows: many }, { detectPii: all });
    assert.equal(busy.matched, 10);
    assert.equal(busy.rate, 1);
    // Same yes, very different thing — and now the two are distinguishable.
    assert.equal(col.confidence, 'incidental');
    assert.equal(busy.confidence, 'likely');
});

test('counting cells does not cost a guard call per cell', async () => {
    // The guard is a CPU-only sidecar. Counting per cell by ASKING per cell
    // would turn a 50-row table into 50 calls per column, which is how a
    // background review starts competing with the chat path people are
    // waiting on. One call per column, same as before the count existed.
    let calls = 0;
    const rows = Array.from({ length: 30 }, (_, i) => ({ supplier: `ACME ${i}`, notes: `mail jan${i}@acme.nl`, total: i }));
    const deps = {
        detectPii: async (text) => {
            calls += 1;
            return { hasPii: true, entities: [...text.matchAll(/\S+@\S+/g)].map((m) => ({ category: 'Email', text: m[0], offset: m.index, length: m[0].length })) };
        },
    };
    const out = await F.personalColumnsByValue({ fields: FIELDS, rows }, deps);
    assert.equal(calls, 2, 'one call per scannable column — not one per cell');
    assert.equal(out.find((c) => c.key === 'notes').matched, 30);
});

test('a column NAMED like the kind its values hold is confirmed; one named nothing like it is weighed', async () => {
    // The two detectors used to ignore each other completely: the names were
    // consulted only when the values were unavailable. A column called
    // "E-mail" full of addresses and a column called "Notes" with one address
    // in it were the same finding, which is the confidence a scanner is
    // supposed to grade (Macie calls it the column-name anchor).
    const rows = [{ email: 'jan@acme.nl', notes: 'nothing' }, { email: 'piet@acme.nl', notes: 'nothing' }];
    const guard = async (text) => ({
        hasPii: true,
        entities: [...text.matchAll(/\S+@\S+/g)].map((m) => ({ category: 'Email', text: m[0], offset: m.index, length: m[0].length })),
    });
    const out = await F.personalColumnsByValue({
        fields: [{ key: 'email', name: 'E-mail', type: 'text' }, { key: 'notes', name: 'Notes', type: 'text' }],
        rows,
    }, { detectPii: guard });
    const named = out.find((c) => c.key === 'email');
    assert.equal(named.confidence, 'confirmed', 'the name says e-mail and the values are e-mail addresses');
    assert.equal(named.nameKind, 'email');
    assert.equal(out.find((c) => c.key === 'notes'), undefined, 'and the guard found nothing in the other one');
});

test('no guard is NOT "no personal data" — it is no answer', async () => {
    // null = not installed; degraded = installed but could not scan. Neither
    // may read as a clean table, or a review would report "nothing found"
    // precisely when it could not look.
    assert.equal(await F.personalColumnsByValue({ fields: FIELDS, rows: ROWS }, { detectPii: async () => null }), null);
    assert.equal(await F.personalColumnsByValue({ fields: FIELDS, rows: ROWS }, { detectPii: async () => ({ hasPii: false, entities: [], degraded: true }) }), null);
    assert.equal(await F.personalColumnsByValue({ fields: FIELDS, rows: ROWS }, { detectPii: async () => { throw new Error('down'); } }), null);
    // A guard that answered and found nothing IS an answer: an empty list.
    assert.deepEqual(await F.personalColumnsByValue({ fields: FIELDS, rows: ROWS }, { detectPii: async () => ({ hasPii: false, entities: [] }) }), []);
    // Nothing to scan is no answer either.
    assert.equal(await F.personalColumnsByValue({ fields: FIELDS, rows: [] }, { detectPii: async () => ({ entities: [] }) }), null);
});

test('guard categories become our words, and an unknown category is not invented into one', () => {
    assert.deepEqual(F.kindsOf([{ category: 'PERSON' }, { category: 'iban' }, { category: 'wingspan' }]), ['name', 'financial']);
    assert.deepEqual(F.kindsOf(null), []);
});

test('the CANONICAL category ids the guard actually sends are not thrown away', () => {
    // This is what the guard returns (core/privacy/piiCategories CANONICAL_IDS,
    // which is what guardClient puts in `category`). The old private map keyed
    // on the id squashed to snake_case, so 'PhoneNumber' became 'phonenumber',
    // matched nothing, and a column holding nothing but telephone numbers —
    // or IBANs, or BSNs, or dates of birth — was reported as clean. Only
    // Person, Email and Address ever survived.
    assert.deepEqual(F.kindsOf([{ category: 'PhoneNumber' }]), ['phone']);
    assert.deepEqual(F.kindsOf([{ category: 'InternationalBankingAccountNumber' }]), ['financial']);
    assert.deepEqual(F.kindsOf([{ category: 'NationalIdentificationNumber' }]), ['id_number']);
    assert.deepEqual(F.kindsOf([{ category: 'DateOfBirth' }]), ['birth']);
    assert.deepEqual(F.kindsOf([{ category: 'MedicalCondition' }]), ['health']);
    assert.deepEqual(F.kindsOf([{ category: 'IPAddress' }]), ['online_id']);
    // A company is not a person — the reason a "supplier" column full of
    // company names must not be reported as personal data.
    assert.deepEqual(F.kindsOf([{ category: 'Organization' }]), []);
});

test('the AI Act signals come from the detector, and a definition it cannot read is null, not false', () => {
    const deps = { signalsFromDefinition: (def, meta) => ({ contains_ai: true, title: meta.title }) };
    const out = F.aiActFacts([{ id: 'a_1', title: 'A', definition: { steps: [] } }, { id: 'a_2', title: 'B' }], deps);
    assert.deepEqual(out[0], { id: 'a_1', title: 'A', signals: { contains_ai: true, title: 'A' } });
    assert.deepEqual(out[1], { id: 'a_2', title: 'B', signals: null }, 'no definition, no claim');
    const throwing = { signalsFromDefinition: () => { throw new Error('bad shape'); } };
    assert.equal(F.aiActFacts([{ id: 'a_3', title: 'C', definition: {} }], throwing)[0].signals, null);
    // The ID travels with the signals: two automations called the same thing
    // are the normal case, and a title key gave the second one the first's.
    const twins = F.aiActFacts([{ id: 'a_1', title: 'Untitled automation', definition: {} }, { id: 'a_2', title: 'Untitled automation', definition: {} }], deps);
    assert.deepEqual(twins.map((x) => x.id), ['a_1', 'a_2']);
});

test('the organisation’s own settings are read, in either spelling, and never invented', async () => {
    const out = await F.orgFacts('org1', { getSettings: async () => ({ legal_bases: ['contract'], default_retention_days: 365, dpo_name: 'Jan' }) });
    assert.deepEqual(out, { legalBases: ['contract'], defaultRetentionDays: 365, hasDpo: true, dataResidency: null });
    const camel = await F.orgFacts('org1', { getSettings: async () => ({ legalBases: ['consent'], defaultRetentionDays: 0, dpoEmail: 'x@y.nl', dataResidency: 'eu' }) });
    assert.deepEqual(camel, { legalBases: ['consent'], defaultRetentionDays: null, hasDpo: true, dataResidency: 'eu' });
    assert.equal(await F.orgFacts('org1', { getSettings: async () => { throw new Error('no db'); } }), null);
});

test('enrich puts it together, and says which method answered the personal-data question', async () => {
    const deps = {
        detectPii: async () => ({ hasPii: true, entities: [{ category: 'email' }] }),
        signalsFromDefinition: () => ({ contains_ai: false }),
        getSettings: async () => ({ legal_bases: ['contract'], default_retention_days: 90 }),
    };
    const out = await F.enrich({
        table: { fields: FIELDS }, rows: ROWS,
        automations: [{ title: 'A', definition: {} }],
        orgId: 'org1',
        privacy: { lawfulBasis: 'contract', retentionDays: '365', subjectColumn: 'email', rowScope: 'all' },
    }, deps);
    assert.equal(out.personalMethod, 'values');
    assert.equal(out.personal.length, 2, 'both text columns held an e-mail in this stub');
    // WHICH columns the guard read, so the review can tell a clean column from
    // one it cannot read at all (a date, a number) — see compliancePhase.
    assert.deepEqual(out.scannedColumns, ['supplier', 'notes']);
    assert.deepEqual(out.privacy, { lawfulBasis: 'contract', retentionDays: 365, retentionField: null, subjectColumn: 'email', rowScope: 'all' });
    assert.equal(out.org.defaultRetentionDays, 90);
    assert.equal(out.aiAct[0].signals.contains_ai, false);
    // Without a guard the method falls back, and the rest still arrives.
    const noGuard = await F.enrich({ table: { fields: FIELDS }, rows: ROWS, automations: [], orgId: 'org1' }, { ...deps, detectPii: async () => null });
    assert.equal(noGuard.personalMethod, 'names');
    assert.equal(noGuard.personal, null);
    assert.equal(noGuard.scannedColumns, null, 'nothing was read, so nothing may claim it was');
    assert.equal(noGuard.org.legalBases[0], 'contract');
});

test('the AI Act detector is handed in by the route, never required here — and without it the facts are null, not false', () => {
    // playbooks/ may not require compliance/ at all — enforced project-wide,
    // for every file in both trees, by server/layering.test.js; not repeated
    // here. routes/playbooks.js wires signalsFromDefinition.
    const bare = F.defaultDeps();
    assert.equal(bare.signalsFromDefinition, null);
    assert.deepEqual(F.aiActFacts([{ id: 'a_1', title: 'A', definition: { steps: [] } }], bare), [{ id: 'a_1', title: 'A', signals: null }]);
    const wired = F.defaultDeps({ signalsFromDefinition: () => ({ contains_ai: true }) });
    assert.deepEqual(F.aiActFacts([{ id: 'a_1', title: 'A', definition: {} }], wired)[0].signals, { contains_ai: true });
    assert.equal(typeof wired.detectPii, 'function', 'an override adds to the defaults, it does not replace them');
});
