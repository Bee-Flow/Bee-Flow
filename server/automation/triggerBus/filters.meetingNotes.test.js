const test = require('node:test');
const assert = require('node:assert');

const { pickMatcher, matchMeetingProcessedFilter } = require('./filters');
const { applyDslFilter, matchFilter } = require('../triggers/dslFilters');

/**
 * meeting-notes.meeting.processed — the tag filter, and what an EMPTY tag filter means.
 *
 * Everything here runs via `pickMatcher(provider, event)` and not directly through the function: that is the
 * only link that dispatch.js makes, and a matcher that exists but is not chosen is precisely the fault that this
 * event already kept hidden earlier.
 *
 * Run: node --test --test-force-exit automation/triggerBus/filters.meetingNotes.test.js
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

    // Why that is necessary: the shallow matcher compares the REQUESTED list with the payload array
    // (`want.includes(got)`), so a tag filter never matched there. Without this rule the rest of this file
    // is meaningless.
    assert.strictEqual(matchFilter(note(), { tags: ['sales'] }), false,
        'de fallback zou dit filter nog steeds weigeren');
    assert.strictEqual(m(note(), { tags: ['sales'] }), true);
});

// ── the empty collection ──────────────────────────────────────────────
//
// Recorded choice: no tags = EVERY completed meeting. The three ways that
// "no tags" can be stored in a saved filter must all do the same thing,
// otherwise the behaviour depends on which screen wrote it.

test('geen tagfilter, in al zijn vormen, laat ELKE afgeronde meeting door', () => {
    const m = pick();
    for (const filter of [undefined, null, {}, { tags: [] }, { tags: '' }, { tags: '   ' }, { tags: ['', '  '] }]) {
        assert.strictEqual(m(note(), filter), true, `filter ${JSON.stringify(filter)} beperkt niets`);
        assert.strictEqual(m(note({ tags: [] }), filter), true, 'ook een notitie zonder tags');
    }
});

test('een lege tagfilter betekent NIET "geen enkele meeting"', () => {
    // The mirror image of the test above, written down separately because this is
    // the decision itself and not a consequence of it: whoever flips it to "none"
    // gets a red test here, with the reason attached.
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
    // No array = we do not know which tags the note carries. Whoever asks for a tag
    // does not get it then.
    assert.strictEqual(m(note({ tags: 'sales' }), { tags: ['sales'] }), false);
    assert.strictEqual(m(note({ tags: undefined }), { tags: ['sales'] }), false);
    // But whoever asks for NOTHING restricts nothing either — there "unreadable"
    // and "empty" do not differ, because there is no claim to test against.
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
    // The emit sets `reprocessed` only on a reprocessing. The shallow
    // matcher read that as `undefined !== false` and therefore refused every
    // first ingest: a filter that never fired instead of one that lets the
    // normal case through.
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
    // The DSL keys are stripped before they reach the matcher; what remains is `{}`,
    // and here that means "every meeting".
    const out = applyDslFilter(note({ tags: [] }), { none: [{ tags: ['geheim'] }] }, pick());
    assert.strictEqual(out, true);
});

test('de matcher is ook los te gebruiken (geëxporteerd voor hergebruik en tests)', () => {
    assert.strictEqual(typeof matchMeetingProcessedFilter, 'function');
    assert.strictEqual(matchMeetingProcessedFilter, pick());
});

// ── a key this matcher does not know, NARROWS ─────────────────

test('een onbekende filtersleutel maakt het filter niet leeg — hij versmalt', () => {
    const m = pick();
    const payload = note({ tags: ['inkoop', 'geheim'] });
    // Shapes that occur in the wild (meetingUsage.js names tagIncludes with a
    // name). Before this matcher they NEVER fired; empty-means-everything plus
    // ignored keys would turn that into "ALWAYS", and every run would hand a note
    // id to whatever hangs behind it.
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
    // ' sales' and 'sales' are two tags for `armMeetingSources`. A matcher that
    // trims would fire on a note that the knowledge source does not arm: two
    // different answers to "does this meeting have tag X".
    const m = pick();
    assert.strictEqual(m(note({ tags: [' sales'] }), { tags: ['sales'] }), false);
    assert.strictEqual(m(note({ tags: ['sales'] }), { tags: [' sales'] }), true, 'de FILTERwaarde is wel een formulierveld');
});
