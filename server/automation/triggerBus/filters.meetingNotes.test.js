const test = require('node:test');
const assert = require('node:assert');

const { pickMatcher, matchMeetingProcessedFilter } = require('./filters');
const { applyDslFilter, matchFilter } = require('../triggers/dslFilters');

/**
 * meeting-notes.meeting.processed — het tagfilter, en wat een LEGE tagfilter
 * betekent.
 *
 * Alles loopt hier via `pickMatcher(provider, event)` en niet rechtstreeks
 * langs de functie: dat is de enige koppeling die dispatch.js legt, en een
 * matcher die bestaat maar niet gekozen wordt is precies de fout die dit
 * event al eerder onzichtbaar hield.
 *
 * Draai: node --test --test-force-exit automation/triggerBus/filters.meetingNotes.test.js
 */

const pick = () => pickMatcher('meeting-notes', 'meeting.processed');
const note = (over = {}) => ({
    transcriptionId: '7c1f9a20-4d3e-4b1a-9c8f-2e6d5a4b3c21',
    tags: ['sales', 'klant-van-dijk'],
    orgId: 'org_9f2c41',
    ...over,
});

test('het event heeft een EIGEN matcher — de ondiepe val is er echt', () => {
    const m = pick();
    assert.notStrictEqual(m, matchFilter, 'meeting.processed valt niet terug op matchFilter');

    // Waarom dat nodig is: de ondiepe matcher vergelijkt de GEVRAAGDE lijst
    // met de payload-array (`want.includes(got)`), dus een tagfilter matchte
    // daar nooit. Zonder deze regel is de rest van dit bestand betekenisloos.
    assert.strictEqual(matchFilter(note(), { tags: ['sales'] }), false,
        'de fallback zou dit filter nog steeds weigeren');
    assert.strictEqual(m(note(), { tags: ['sales'] }), true);
});

// ── de lege verzameling ──────────────────────────────────────────────
//
// Vastgelegde keuze: geen tags = ELKE afgeronde meeting. De drie manieren
// waarop "geen tags" in een opgeslagen filter kan staan moeten alle drie
// hetzelfde doen, anders hangt het gedrag af van welk scherm het schreef.

test('geen tagfilter, in al zijn vormen, laat ELKE afgeronde meeting door', () => {
    const m = pick();
    for (const filter of [undefined, null, {}, { tags: [] }, { tags: '' }, { tags: '   ' }, { tags: ['', '  '] }]) {
        assert.strictEqual(m(note(), filter), true, `filter ${JSON.stringify(filter)} beperkt niets`);
        assert.strictEqual(m(note({ tags: [] }), filter), true, 'ook een notitie zonder tags');
    }
});

test('een lege tagfilter betekent NIET "geen enkele meeting"', () => {
    // Het spiegelbeeld van de test hierboven, apart opgeschreven omdat dit de
    // beslissing zelf is en niet een gevolg ervan: wie hem omdraait naar
    // "geen enkele" krijgt hier een rode test met de reden erbij.
    assert.strictEqual(pick()(note(), { tags: [] }), true,
        'leeg = geen beperking; "vuur nooit" vraagt niemand aan een trigger, die zet de regel uit');
});

// ── het filter doet wat het belooft ──────────────────────────────────

test('met tags: elke gevraagde tag telt (ANY-of), de rest niet', () => {
    const m = pick();
    assert.strictEqual(m(note(), { tags: ['sales'] }), true, 'eerste tag van de notitie');
    assert.strictEqual(m(note(), { tags: ['klant-van-dijk'] }), true, 'tweede tag van de notitie');
    assert.strictEqual(m(note(), { tags: ['inkoop', 'sales'] }), true, 'één overlap is genoeg');
    assert.strictEqual(m(note(), { tags: ['inkoop'] }), false, 'geen overlap');
    assert.strictEqual(m(note({ tags: [] }), { tags: ['sales'] }), false, 'notitie zonder tags');
});

test('één tag als kale string mag ook, en witruimte wordt getrimd', () => {
    const m = pick();
    assert.strictEqual(m(note(), { tags: 'sales' }), true);
    assert.strictEqual(m(note(), { tags: '  sales  ' }), true);
    assert.strictEqual(m(note(), { tags: [' sales ', ''] }), true);
    assert.strictEqual(m(note(), { tags: 'inkoop' }), false);
});

test('vergelijken gaat exact en hoofdlettergevoelig, net als de meeting_tag-kennisbron', () => {
    const m = pick();
    assert.strictEqual(m(note(), { tags: ['Sales'] }), false);
    assert.strictEqual(m(note(), { tags: ['sale'] }), false, 'geen prefix-match');
});

test('een onleesbare tagverzameling versmalt — leeg en onleesbaar zijn niet hetzelfde', () => {
    const m = pick();
    // Geen array = we weten niet welke tags de notitie draagt. Wie een tag
    // vraagt, krijgt hem dan niet.
    assert.strictEqual(m(note({ tags: 'sales' }), { tags: ['sales'] }), false);
    assert.strictEqual(m(note({ tags: undefined }), { tags: ['sales'] }), false);
    // Maar wie NIETS vraagt, beperkt ook niets — daar verschilt "onleesbaar"
    // van "leeg" niet, want er is geen bewering om aan te toetsen.
    assert.strictEqual(m(note({ tags: 'sales' }), {}), true);
    assert.strictEqual(m(note({ tags: undefined }), { tags: [] }), true);
});

test('geen payload matcht nooit', () => {
    assert.strictEqual(pick()(null, {}), false);
    assert.strictEqual(pick()(undefined, undefined), false);
});

// ── reprocessed is driewaardig ───────────────────────────────────────

test('reprocessed: weglaten = alle drie de aanleidingen', () => {
    const m = pick();
    assert.strictEqual(m(note(), {}), true);
    assert.strictEqual(m(note({ reprocessed: true }), {}), true);
});

test('reprocessed:false vraagt een NIEUWE notitie — en de payload laat de sleutel weg', () => {
    // De emit zet `reprocessed` alleen bij een herverwerking. De ondiepe
    // matcher las dat als `undefined !== false` en weigerde dus élke eerste
    // ingest: een filter dat nooit vuurde in plaats van een filter dat het
    // gewone geval doorlaat.
    const m = pick();
    assert.strictEqual(matchFilter(note(), { reprocessed: false }), false, 'de fallback weigerde dit');
    assert.strictEqual(m(note(), { reprocessed: false }), true);
    assert.strictEqual(m(note({ reprocessed: true }), { reprocessed: false }), false);
});

test('reprocessed:true vraagt alleen een herverwerking of nieuwe samenvatting', () => {
    const m = pick();
    assert.strictEqual(m(note({ reprocessed: true }), { reprocessed: true }), true);
    assert.strictEqual(m(note(), { reprocessed: true }), false);
});

test('tags en reprocessed werken samen als EN, niet als OF', () => {
    const m = pick();
    const f = { tags: ['sales'], reprocessed: false };
    assert.strictEqual(m(note(), f), true);
    assert.strictEqual(m(note({ reprocessed: true }), f), false, 'juiste tag, verkeerde aanleiding');
    assert.strictEqual(m(note({ tags: ['inkoop'] }), f), false, 'juiste aanleiding, verkeerde tag');
});

// ── samenspel met de DSL, zoals dispatch.js hem toepast ──────────────

test('uitsluiten hoeft geen eigen sleutel: none[] werkt bovenop deze matcher', () => {
    const m = pick();
    const run = (payload, filter) => applyDslFilter(payload, filter, m);
    assert.strictEqual(run(note(), { none: [{ tags: ['klant-van-dijk'] }] }), false);
    assert.strictEqual(run(note({ tags: ['sales'] }), { none: [{ tags: ['klant-van-dijk'] }] }), true);
    // any[] versmalt op dezelfde manier als elders.
    assert.strictEqual(run(note(), { any: [{ tags: ['inkoop'] }, { tags: ['sales'] }] }), true);
    assert.strictEqual(run(note(), { any: [{ tags: ['inkoop'] }] }), false);
});

test('een filter met alleen DSL-sleutels beperkt de tags niet', () => {
    // De DSL-sleutels worden gestript voor ze bij de matcher komen; wat
    // overblijft is `{}` en dat betekent hier "elke meeting".
    const out = applyDslFilter(note({ tags: [] }), { none: [{ tags: ['geheim'] }] }, pick());
    assert.strictEqual(out, true);
});

test('de matcher is ook los te gebruiken (geëxporteerd voor hergebruik en tests)', () => {
    assert.strictEqual(typeof matchMeetingProcessedFilter, 'function');
    assert.strictEqual(matchMeetingProcessedFilter, pick());
});

// ── een sleutel die deze matcher niet kent, VERSMALT ─────────────────

test('een onbekende filtersleutel maakt het filter niet leeg — hij versmalt', () => {
    const m = pick();
    const payload = note({ tags: ['inkoop', 'geheim'] });
    // Vormen die in het wild voorkomen (meetingUsage.js noemt tagIncludes met
    // naam). Vóór deze matcher vuurden ze NOOIT; leeg-is-alles plus genegeerde
    // sleutels zou er "ALTIJD" van maken, en elke run overhandigt een
    // notitie-id aan wat er ook achter hangt.
    assert.strictEqual(m(payload, { tagIncludes: 'sales' }), false);
    assert.strictEqual(m(payload, { tag: 'sales' }), false);
    assert.strictEqual(m(payload, { tagsAny: ['sales'] }), false);
    assert.strictEqual(m(payload, { tags: { any: ['sales'] } }), false);
    // En een onbekende sleutel die WEL klopt tegen de payload houdt hem heel.
    assert.strictEqual(m(payload, { orgId: 'org_9f2c41' }), true);
    assert.strictEqual(m(payload, { orgId: 'org_anders' }), false);
});

test('een bekende sleutel blijft leidend naast een onbekende', () => {
    const m = pick();
    const payload = note({ tags: ['sales'], reprocessed: true });
    assert.strictEqual(m(payload, { tags: ['sales'], orgId: 'org_9f2c41' }), true);
    assert.strictEqual(m(payload, { tags: ['inkoop'], orgId: 'org_9f2c41' }), false);
    assert.strictEqual(m(payload, { reprocessed: false, orgId: 'org_9f2c41' }), false);
});

test('in none[] kan de submatcher NEE zeggen op een sleutel die hij niet kent', () => {
    // De spiegelkant: zei de submatcher altijd JA, dan sloot `none` alles uit
    // en vuurde de regel nooit meer.
    const payload = note({ tags: ['inkoop', 'geheim'] });
    assert.strictEqual(applyDslFilter(payload, { none: [{ tagIncludes: 'geheim' }] }, pick()), true);
    assert.strictEqual(applyDslFilter(payload, { none: [{ orgId: 'org_9f2c41' }] }, pick()), false);
});

test('payload-tags worden NIET getrimd — de kennisbron doet dat ook niet', () => {
    // ' sales' en 'sales' zijn voor `armMeetingSources` twee tags. Een matcher
    // die trimt zou vuren op een notitie die de kennisbron niet arm: twee
    // verschillende antwoorden op "heeft deze meeting tag X".
    const m = pick();
    assert.strictEqual(m(note({ tags: [' sales'] }), { tags: ['sales'] }), false);
    assert.strictEqual(m(note({ tags: ['sales'] }), { tags: [' sales'] }), true, 'de FILTERwaarde is wel een formulierveld');
});
