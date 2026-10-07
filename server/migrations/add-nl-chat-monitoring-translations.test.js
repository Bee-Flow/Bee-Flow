/**
 * Dutch for chat signals (chat_monitoring.*). Pinned here:
 * - both silent failure modes: a Dutch key with no English key is stored and
 *   never read, and an English key with no Dutch value leaves one English
 *   sentence on a Dutch card, in a Dutch chat or in a Dutch notice;
 * - the fragments the notice text is assembled from keep the shape that
 *   joins them (a leading space, a leading comma, the paragraph breaks);
 * - the notice text and the "missing" label quote the objection switch
 *   exactly as the chat shows it;
 * - the words: Dutch legal terms, informal "je", and never "anonymous" in
 *   either language.
 *
 * Run: node --test migrations/add-nl-chat-monitoring-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { up, NL_TRANSLATIONS, SAME_AS_ENGLISH } = require('./add-nl-chat-monitoring-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');
const { NL_TRANSLATIONS: BOOT_LIST } = require('../boot/bootMigrations');

const owned = (k) => k.startsWith('chat_monitoring.');
const ownedEnglish = () => Object.keys(GUI_DEFAULTS).filter(owned);

test('every Dutch key has an English key in the chat_monitoring namespace', () => {
    const keys = [...Object.keys(NL_TRANSLATIONS), ...SAME_AS_ENGLISH];
    assert.deepStrictEqual(keys.filter((k) => !(k in GUI_DEFAULTS)), [], 'Dutch keys with no English counterpart');
    assert.deepStrictEqual(keys.filter((k) => !owned(k)), [], 'this catalogue only writes chat_monitoring.* keys');
});

test('every English chat_monitoring key has Dutch, or is declared identical', () => {
    const same = new Set(SAME_AS_ENGLISH);
    const untranslated = ownedEnglish().filter((k) => !NL_TRANSLATIONS[k] && !same.has(k));
    assert.deepStrictEqual(untranslated, []);
    assert.ok(Object.keys(NL_TRANSLATIONS).length > 200);
});

test('no Dutch value is blank or the English one copied over', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.ok(String(v || '').trim(), `${k} has no Dutch value`);
        assert.notStrictEqual(v, GUI_DEFAULTS[k], `${k} was never actually translated: declare it in SAME_AS_ENGLISH or translate it`);
    }
    for (const k of SAME_AS_ENGLISH) {
        assert.ok(!(k in NL_TRANSLATIONS), `${k} is both seeded and declared identical`);
        assert.doesNotMatch(GUI_DEFAULTS[k], /\b[a-z]{3,}\b/, `${k} is a sentence, not a shared symbol: translate it`);
    }
});

test('placeholders survive translation', () => {
    const holes = (s) => (String(s).match(/\{[a-z_]+\}/gi) || []).sort();
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.deepStrictEqual(holes(v), holes(GUI_DEFAULTS[k]), `${k}: placeholders differ from English`);
    }
});

test('the notice fragments keep the shape that joins them', () => {
    // {interest} is appended right after "{legal_basis}." and {kinds_clause}
    // right after "scan failed": the leading space and comma are the glue.
    assert.match(NL_TRANSLATIONS['chat_monitoring.notice_interest_f'], /^ \S/);
    assert.match(NL_TRANSLATIONS['chat_monitoring.notice_template_kinds'], /^, \S/);
    const breaks = (s) => (s.match(/\n/g) || []).length;
    assert.strictEqual(
        breaks(NL_TRANSLATIONS['chat_monitoring.notice_template']),
        breaks(GUI_DEFAULTS['chat_monitoring.notice_template']),
        'the notice text has a different paragraph structure than the English',
    );
});

test('the notice text and the missing label quote the objection switch word for word', () => {
    for (const dict of [GUI_DEFAULTS, NL_TRANSLATIONS]) {
        const label = dict['chat_monitoring.chat.dont_count'];
        assert.ok(dict['chat_monitoring.notice_template'].includes(`"${label}"`), `notice text does not quote "${label}"`);
        assert.ok(dict['chat_monitoring.missing.objection_unavailable'].includes(`"${label}"`), `missing label does not quote "${label}"`);
    }
});

test('Dutch legal terms where a DPO expects them', () => {
    const nl = NL_TRANSLATIONS;
    assert.strictEqual(nl['chat_monitoring.legal_basis_label'], 'Verwerkingsgrondslag');
    assert.match(nl['chat_monitoring.legal_basis.art6_1_f'], /^Gerechtvaardigd belang \(art\. 6 lid 1 sub f AVG\)$/);
    assert.strictEqual(nl['chat_monitoring.works_council_label'], 'Ondernemingsraad');
    assert.match(nl['chat_monitoring.works_council.consent'], /^Instemming/);
    assert.match(nl['chat_monitoring.dpia_label'], /\(DPIA\)$/);
    assert.match(nl['chat_monitoring.notice_url'], /^Privacyverklaring/);
    assert.match(nl['chat_monitoring.ropa_preview'], /Verwerkingsregister/);
    assert.match(nl['chat_monitoring.ropa.f_retention'], /^Bewaartermijn$/);
    assert.match(nl['chat_monitoring.works_council_pending_hint'], /art\. 27 lid 1 sub l WOR/);
});

test('informal "je", no "routine", and never "anonymous" in either language', () => {
    for (const [k, v] of Object.entries(NL_TRANSLATIONS)) {
        assert.doesNotMatch(v, /\b(u|uw|Uw)\b/, `${k} addresses the reader formally`);
        assert.doesNotMatch(v, /routine/i, `${k}: the product says "automatisering"`);
        assert.doesNotMatch(v, /anoni?em/i, `${k}: chat signals never call themselves anonymous`);
    }
    for (const k of ownedEnglish()) {
        assert.doesNotMatch(GUI_DEFAULTS[k], /anonym/i, `${k}: chat signals never call themselves anonymous`);
    }
});

test('up() seeds only missing Dutch keys, and not the identical ones', async () => {
    const calls = [];
    const languageStore = {
        addMissingGUITranslations: async (locale, translations) => {
            calls.push({ locale, translations });
            return { added: 0 };
        },
    };
    assert.deepStrictEqual(await up({ languageStore }), { added: 0 });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].locale, 'nl');
    assert.deepStrictEqual(calls[0].translations, NL_TRANSLATIONS);
    assert.ok(SAME_AS_ENGLISH.every((k) => !(k in calls[0].translations)));
});

test('it runs at boot, after the Compliance Center catalogue and before the routine rename', () => {
    const at = BOOT_LIST.indexOf('add-nl-chat-monitoring-translations');
    assert.ok(at > BOOT_LIST.indexOf('add-nl-compliance-center-translations'), 'not listed in boot/bootMigrations.js NL_TRANSLATIONS, or listed too early');
    assert.ok(at < BOOT_LIST.indexOf('rename-routine-i18n-2026-10'));
});
