/**
 * De poort naar buiten, puur getest.
 *
 * Elke test hier gaat over één zin uit het ontwerp: "Bij Openbaar zetten wordt
 * publicColumns gevraagd — zonder die keuze gaat er niets naar buiten." Dat is
 * geen UI-belofte maar een regel die in `applyColumnChoice` staat, en die moet
 * in de VERSMALLENDE richting fout gaan als hij ooit verschuift.
 *
 * Run: node --test --test-force-exit core/webpages/webpagePublicAudience.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    audienceModeOf, describeColumnGate, applyColumnChoice,
    accessOptionsChanged, normalizeEmails, buildAudienceModel,
    PERSONAL, ORG, GROUPS,
} = require('./webpagePublicAudience');

// ── de drie interne rijen ────────────────────────────────────────────

test('de drie interne standen zijn dezelfde afleiding als de capsule', () => {
    assert.strictEqual(audienceModeOf({ isPublished: false, sharedGroups: ['g1'] }), PERSONAL,
        'niet gepubliceerd is persoonlijk, ook mét groepen in de kolom');
    assert.strictEqual(audienceModeOf({ isPublished: true, sharedGroups: [] }), ORG,
        'gepubliceerd zonder groepen = hele organisatie');
    assert.strictEqual(audienceModeOf({ isPublished: true, sharedGroups: ['g1'] }), GROUPS);
    assert.strictEqual(audienceModeOf({ isPublished: true, sharedGroups: [null, ''] }), ORG,
        'lege waarden in de groepenlijst zijn geen groepen');
});

// ── de kolompoort ────────────────────────────────────────────────────

test('een tabel die NIET in de keuze staat, gaat op nul publieke kolommen', () => {
    const tables = [
        { datatableId: 't1', mode: 'read', columns: ['naam', 'bsn'], publicColumns: ['naam', 'bsn'] },
        { datatableId: 't2', mode: 'read', columns: ['status'], publicColumns: ['status'] },
    ];
    // t2 ontbreekt in het antwoord: weglaten is geen instemming.
    const out = applyColumnChoice(tables, { t1: ['naam'] });
    assert.deepStrictEqual(out[0].publicColumns, ['naam']);
    assert.deepStrictEqual(out[1].publicColumns, [],
        'een tabel zonder keuze mag niet stilzwijgend zijn vorige antwoord houden');
});

test('een lege keuze zet ALLES dicht — nooit "dan maar alles"', () => {
    const tables = [{ datatableId: 't1', columns: ['a', 'b'], publicColumns: ['a', 'b'] }];
    for (const choice of [undefined, null, {}, [], 'alles', 42]) {
        const out = applyColumnChoice(tables, choice);
        assert.deepStrictEqual(out[0].publicColumns, [], `keuze ${JSON.stringify(choice)} moet dichtzetten`);
    }
});

test('een gekozen kolom die niet in columns staat, valt af', () => {
    const tables = [{ datatableId: 't1', columns: ['naam'], publicColumns: [] }];
    const out = applyColumnChoice(tables, { t1: ['naam', 'bsn', '  ', 42, 'naam'] });
    assert.deepStrictEqual(out[0].publicColumns, ['naam'],
        'buiten de binding, leeg, niet-string en dubbel vallen allemaal af');
});

test('de keuze kan geen tabel TOEVOEGEN die niet gebonden is', () => {
    const out = applyColumnChoice([{ datatableId: 't1', columns: ['a'], publicColumns: [] }],
        { t1: ['a'], t_vreemd: ['bsn'] });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].datatableId, 't1');
});

test('applyColumnChoice raakt niets anders aan de binding aan', () => {
    const tables = [{ datatableId: 't1', mode: 'readwrite', columns: ['a'], publicColumns: [], label: 'x' }];
    const out = applyColumnChoice(tables, { t1: ['a'] });
    assert.strictEqual(out[0].mode, 'readwrite', 'de interne schrijfmodus is niet aan deze poort');
    assert.strictEqual(out[0].label, 'x');
});

test('describeColumnGate houdt intern en publiek uit elkaar', () => {
    const gate = describeColumnGate([
        { datatableId: 't1', mode: 'readwrite', columns: ['a', 'b'], publicColumns: ['a'] },
        { datatableId: 't2', mode: 'read', columns: ['c'], publicColumns: [] },
        { datatableId: '', columns: ['x'] },      // zonder id bestaat de binding niet
    ]);
    assert.strictEqual(gate.tables.length, 2);
    assert.strictEqual(gate.anyBound, true);
    assert.strictEqual(gate.sharingCount, 1, 'alleen t1 stuurt iets naar buiten');
    assert.strictEqual(gate.tables[0].mode, 'readwrite');
    assert.strictEqual(gate.tables[0].publicMode, 'read',
        'publiek is ALTIJD alleen-lezen, ook bij een readwrite-binding');
    assert.strictEqual(gate.tables[1].share, false);
});

test('nul gebonden tabellen is iets anders dan nul delende tabellen', () => {
    const geen = describeColumnGate([]);
    const dicht = describeColumnGate([{ datatableId: 't1', columns: ['a'], publicColumns: [] }]);
    assert.strictEqual(geen.anyBound, false);
    assert.strictEqual(dicht.anyBound, true);
    assert.strictEqual(geen.sharingCount, 0);
    assert.strictEqual(dicht.sharingCount, 0);
    assert.strictEqual(geen.tables.length, 0);
    assert.strictEqual(dicht.tables.length, 1,
        'de gebonden-maar-dichte tabel MOET in de lijst blijven staan, anders leest het scherm hem als "er hangt niets aan"');
});

// ── link houden of vervangen ─────────────────────────────────────────

test('zonder bestaande share is er altijd iets te veranderen', () => {
    assert.strictEqual(accessOptionsChanged(null, { accessMode: 'unlisted' }), true);
});

test('dezelfde toegangsmodus zonder nieuw wachtwoord houdt de link', () => {
    const share = { accessMode: 'unlisted', allowedEmails: null };
    assert.strictEqual(accessOptionsChanged(share, { accessMode: 'unlisted' }), false);
    assert.strictEqual(accessOptionsChanged(share, {}), false, 'geen modus meegegeven = unlisted');
});

test('een meegestuurd wachtwoord telt ALTIJD als wijziging', () => {
    const share = { accessMode: 'password', allowedEmails: null };
    assert.strictEqual(accessOptionsChanged(share, { accessMode: 'password' }), false);
    assert.strictEqual(accessOptionsChanged(share, { accessMode: 'password', password: 'hetzelfde?' }), true,
        'we kunnen niet weten of het hetzelfde is, dus mag de wissel niet wegvallen');
    assert.strictEqual(accessOptionsChanged(share, { accessMode: 'password', password: '' }), false,
        'een leeg veld is geen wachtwoordwissel');
});

test('een gewijzigde ontvangerslijst vervangt de link, een herordende niet', () => {
    const share = { accessMode: 'email', allowedEmails: ['a@x.nl', 'b@x.nl'] };
    assert.strictEqual(accessOptionsChanged(share, { accessMode: 'email', allowedEmails: ['B@X.nl', ' a@x.nl '] }), false,
        'hoofdletters en spaties zijn geen wijziging');
    assert.strictEqual(accessOptionsChanged(share, { accessMode: 'email', allowedEmails: ['a@x.nl'] }), true);
    assert.strictEqual(accessOptionsChanged(share, { accessMode: 'unlisted' }), true,
        'van e-mailgated naar unlisted is een verbreding en dus zeker een wijziging');
});

test('normalizeEmails ontdubbelt, verkleint en sorteert', () => {
    assert.deepStrictEqual(normalizeEmails([' B@x.nl', 'a@x.nl', 'b@X.NL', 3, null, '']), ['a@x.nl', 'b@x.nl']);
    assert.deepStrictEqual(normalizeEmails('a@x.nl'), []);
});

// ── het model ────────────────────────────────────────────────────────

test('zonder canonieke share is de pagina niet openbaar, ook mét adres', () => {
    const m = buildAudienceModel({
        webpage: { isPublished: true, sharedGroups: [], slug: 'prijzen-k3f9x2mq7bd4' },
        canonicalShare: null,
        baseUrl: 'https://voorbeeld.nl/',
    });
    assert.strictEqual(m.public.on, false);
    assert.strictEqual(m.address.path, '/w/prijzen-k3f9x2mq7bd4',
        'het adres blijft bestaan als openbaar uit staat — het wordt alleen niet bediend');
    assert.strictEqual(m.address.url, 'https://voorbeeld.nl/w/prijzen-k3f9x2mq7bd4');
    assert.strictEqual(m.internal.mode, ORG);
});

test('zonder slug is er geen adres — niet een leeg adres', () => {
    const m = buildAudienceModel({ webpage: { isPublished: false }, baseUrl: 'https://x.nl' });
    assert.strictEqual(m.address, null);
});

test('het model spreekt de twee eigenschappen van het publieke oppervlak uit', () => {
    const m = buildAudienceModel({
        webpage: { slug: 's', isPublished: false },
        canonicalShare: { id: 'sh1', accessMode: 'password', hasPassword: true, allowedEmails: null, expiresAt: null },
        shareCount: 3,
    });
    assert.strictEqual(m.public.on, true);
    assert.strictEqual(m.public.tablesReadOnly, true, 'publieke tabelbindingen zijn alleen-lezen');
    assert.strictEqual(m.public.agentRuns, false, 'het Agent-blok draait niet op een publieke share');
    assert.strictEqual(m.shareCount, 3, 'het N-share-model blijft zichtbaar naast de canonieke');
});

test('de publieke AI-brug staat in het model — de enige eigenschap die geld kost', () => {
    // publicViewer.js injecteert bij `publicEnabled` een ECHTE beeflowAI-brug in
    // het publieke document; anonieme bezoekers chatten dan op het budget van de
    // auteur. Zwijgt het model daarover, dan lezen de twee constanten
    // (tablesReadOnly / agentRuns) als "publiek draait er geen AI".
    const aan = buildAudienceModel({
        webpage: { slug: 's' },
        canonicalShare: { id: 'sh1' },
        ai: { enabled: true, publicEnabled: true, publicGroundOnPage: true },
    });
    assert.strictEqual(aan.public.aiKnown, true);
    assert.strictEqual(aan.public.aiRuns, true);
    assert.strictEqual(aan.public.aiGroundsOnPage, true,
        'gegrond op de pagina: dan gaat er ook INHOUD naar buiten, langs de kolompoort heen');

    const uit = buildAudienceModel({ webpage: { slug: 's' }, ai: { enabled: true, publicEnabled: false } });
    assert.strictEqual(uit.public.aiKnown, true);
    assert.strictEqual(uit.public.aiRuns, false);
    assert.strictEqual(uit.public.aiGroundsOnPage, false);

    // Alleen letterlijk true verbreedt — net als in de normalizer.
    const raar = buildAudienceModel({ webpage: {}, ai: { publicEnabled: 'ja', publicGroundOnPage: 1 } });
    assert.strictEqual(raar.public.aiRuns, false);
    assert.strictEqual(raar.public.aiGroundsOnPage, false);
});

test('een NIET MEEGEGEVEN ai-plak is "niet gelezen", niet "uit"', () => {
    const stuk = buildAudienceModel({ webpage: { slug: 's' }, canonicalShare: { id: 'sh1' } });
    assert.strictEqual(stuk.public.aiKnown, false,
        '"er draait publiek geen AI" mag niet uit een veld komen dat niemand bekeek');
    const leeg = buildAudienceModel({ webpage: { slug: 's' }, ai: 'nee' });
    assert.strictEqual(leeg.public.aiKnown, false, 'een niet-object is geen lezing');
});

test('een ONLEESBARE share is niet hetzelfde als "niet openbaar"', () => {
    const stuk = buildAudienceModel({ webpage: { slug: 's' }, canonicalShare: null, canonicalShareKnown: false });
    const uit = buildAudienceModel({ webpage: { slug: 's' }, canonicalShare: null });
    assert.strictEqual(stuk.public.known, false,
        '"niet openbaar" is een bewering over blootstelling en mag niet uit een mislukte lezing komen');
    assert.strictEqual(uit.public.known, true);
    assert.strictEqual(stuk.public.on, false);
    assert.strictEqual(uit.public.on, false);
});

test('het model draagt de oplossing waar de pagina in zit, of niets', () => {
    const met = buildAudienceModel({ webpage: {}, solution: { id: 'p1', name: 'Offertes' } });
    assert.deepStrictEqual(met.solution, { id: 'p1', name: 'Offertes' });
    assert.strictEqual(buildAudienceModel({ webpage: {} }).solution, null);
});
