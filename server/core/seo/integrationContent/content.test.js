'use strict';

// The integration page content against the shipped catalogues: every id, tool
// and event the content names must exist, both languages must be complete, and
// the text must keep to the writing rules of the public site.

const test = require('node:test');
const assert = require('node:assert/strict');
const { FACTS, CONTENT_LOCALES, buildPageModel } = require('./model.mts');
const { EN } = require('./en/index.mts');
const { NL } = require('./nl/index.mts');
const { listGalleryItems } = require('../integrationsDirectory');
const { integrationCatalog } = require('../../../routes/publicIntegrationsRender');

const catalogIds = new Set(listGalleryItems().map(i => i.id));
const catalog = integrationCatalog();
const LANGS = { en: EN, nl: NL };

/** Every string of one prose entry, with where it sits. */
function strings(prose) {
    return [
        ['title', prose.title], ['description', prose.description], ['summary', prose.summary], ['name', prose.name || ''],
        ...prose.intro.map((s, i) => [`intro[${i}]`, s]),
        ...Object.entries(prose.groups).map(([k, s]) => [`groups.${k}`, s]),
        ...prose.connect.map((s, i) => [`connect[${i}]`, s]),
        ...prose.limits.map((s, i) => [`limits[${i}]`, s]),
        ...(prose.examples || []).map((s, i) => [`examples[${i}]`, s]),
    ];
}

test('every content entry names an integration that is in the catalogue', () => {
    const unknown = Object.keys(FACTS).filter(id => !catalogIds.has(id));
    assert.deepEqual(unknown, [], `facts.mts names integrations the catalogue does not ship: ${unknown.join(', ')}`);
    for (const [lang, content] of Object.entries(LANGS)) {
        const stray = Object.keys(content.prose).filter(id => !catalogIds.has(id) || !Object.hasOwn(FACTS, id));
        assert.deepEqual(stray, [], `${lang}.mts has prose for ids without facts or outside the catalogue: ${stray.join(', ')}`);
    }
});

test('both languages cover every integration with facts, group for group', () => {
    for (const id of Object.keys(FACTS)) {
        for (const lang of CONTENT_LOCALES) {
            const prose = LANGS[lang].prose[id];
            assert.ok(prose, `${id}: no ${lang} prose`);
            const keys = FACTS[id].groups.map(g => g.key).sort();
            assert.deepEqual(Object.keys(prose.groups).sort(), keys, `${id} (${lang}): one sentence per tool group`);
            assert.ok(prose.intro.length && prose.connect.length && prose.limits.length, `${id} (${lang}): intro, connect and limits`);
        }
        assert.equal((EN.prose[id].examples || []).length, (NL.prose[id].examples || []).length, `${id}: same number of examples in both languages`);
    }
});

test('every tool the content names is shipped in its toolset', () => {
    for (const [id, facts] of Object.entries(FACTS)) {
        const set = catalog.toolsets[facts.toolset];
        assert.ok(Array.isArray(set) && set.length, `${id}: toolset ${facts.toolset} is not shipped`);
        const shipped = new Set(set.map(t => t.function.name));
        const missing = facts.groups.flatMap(g => g.tools).filter(t => !shipped.has(t));
        assert.deepEqual(missing, [], `${id}: tools not in ${facts.toolset}: ${missing.join(', ')}`);
    }
});

test('every event rule matches events the registry offers, and every shown event has a Dutch name', () => {
    for (const [id, facts] of Object.entries(FACTS)) {
        for (const rule of facts.events || []) {
            const source = catalog.triggerSources.find(s => s.id === rule.provider && !s.hidden);
            assert.ok(source, `${id}: trigger provider ${rule.provider} is not offered`);
            const hits = source.events.filter(e => !e.hidden && (!rule.prefix || e.id.startsWith(rule.prefix)));
            assert.ok(hits.length, `${id}: no event of ${rule.provider} starts with ${rule.prefix}`);
            for (const e of hits) assert.ok(NL.eventLabels[`${rule.provider}:${e.id}`], `nl/index.mts: no Dutch name for ${rule.provider}:${e.id}`);
        }
    }
});

test('titles fit 58 characters with the site name, descriptions 155, and both are unique', () => {
    for (const [lang, content] of Object.entries(LANGS)) {
        const titles = new Set();
        const descriptions = new Set();
        for (const [id, prose] of Object.entries(content.prose)) {
            const full = `${prose.title} | Bee Flow`;
            assert.ok(full.length <= 58, `${id} (${lang}): title is ${full.length} characters: ${full}`);
            assert.ok(prose.description.length <= 155, `${id} (${lang}): description is ${prose.description.length} characters`);
            assert.ok(!titles.has(prose.title), `${id} (${lang}): title used twice`);
            assert.ok(!descriptions.has(prose.description), `${id} (${lang}): description used twice`);
            titles.add(prose.title);
            descriptions.add(prose.description);
        }
        assert.ok(`${content.ui.directoryTitle} | Bee Flow`.length <= 58);
    }
});

const BANNED = {
    en: /\b(seamless(ly)?|robust|powerful|leverag\w*|unlock\w*|empower\w*|effortless(ly)?|crucial|moreover|furthermore)\b|not just/i,
    nl: /\b(naadloos|naadloze|krachtig\w*|cruciaal|cruciale|essentieel|essentiële|bovendien|echter|moeiteloos|moeiteloze)\b/i,
};
const EVERY_LANGUAGE = [
    [/[–—]/, 'an en or em dash'],
    [/!/, 'an exclamation mark'],
    [/\p{Extended_Pictographic}/u, 'an emoji'],
    [/[€$]|\bEUR\b|\beuro\b/i, 'a price'],
    [/\b(Free|Starter|Pro|Enterprise)\b/, 'a licence tier name'],
];

test('the text keeps to the writing rules', () => {
    for (const [lang, content] of Object.entries(LANGS)) {
        const all = [
            ...Object.entries(content.prose).flatMap(([id, p]) => strings(p).map(([where, s]) => [`${id}.${where}`, s, id])),
            ...Object.entries(content.ui).flatMap(([k, v]) => (typeof v === 'string' ? [[`ui.${k}`, v, '']] : Object.entries(v).map(([k2, s]) => [`ui.${k}.${k2}`, s, '']))),
            ...Object.entries(content.eventLabels).map(([k, s]) => [`event ${k}`, s, '']),
        ];
        for (const [where, text, id] of all) {
            assert.ok(!BANNED[lang].test(text), `${lang} ${where}: banned word in "${text}"`);
            for (const [re, what] of EVERY_LANGUAGE) assert.ok(!re.test(text), `${lang} ${where}: ${what} in "${text}"`);
            if (id !== 'n8n') assert.ok(!/n8n/i.test(text), `${lang} ${where}: "n8n" outside the n8n page`);
        }
    }
});

test('a page that calls itself read-only has only reading tools', () => {
    const READ_ONLY = /read-only|alleen[ -]lezen|leest alleen/i;
    for (const [lang, content] of Object.entries(LANGS)) {
        for (const [id, prose] of Object.entries(content.prose)) {
            if (!strings(prose).some(([, s]) => READ_ONLY.test(s))) continue;
            const writes = catalog.toolsets[FACTS[id].toolset].map(t => t.function.name).filter(t => catalog.effectOf(t) !== 'reads');
            assert.deepEqual(writes, [], `${id} (${lang}) says read-only, but these tools write: ${writes.join(', ')}`);
        }
    }
});

test('every related link points at a catalogue integration', () => {
    for (const [id, facts] of Object.entries(FACTS)) {
        for (const r of facts.related || []) assert.ok(catalogIds.has(r) && r !== id, `${id}: related ${r}`);
    }
});

test('a page model only lists shipped tools and drops a group whose tools are gone', () => {
    const trimmed = { ...catalog, toolsets: { ...catalog.toolsets, GMAIL_TOOLS: catalog.toolsets.GMAIL_TOOLS.filter(t => !t.function.name.startsWith('gmail_search') && t.function.name !== 'gmail_compose') } };
    const model = buildPageModel('gmail', 'en', trimmed);
    const tools = model.lines.flatMap(l => l.tools);
    assert.ok(!tools.includes('gmail_search') && !tools.includes('gmail_compose'));
    const none = buildPageModel('gmail', 'en', { ...catalog, toolsets: {} });
    assert.deepEqual(none.lines, []);
    assert.equal(none.access, null);
    assert.equal(buildPageModel('music-gen', 'en', catalog), null, 'no prose for an integration without shipped tools');
});

test('effects come from the side-effect map: Gmail sends, AFAS only reads', () => {
    assert.equal(buildPageModel('gmail', 'en', catalog).access, 'sends');
    assert.equal(buildPageModel('afas-profit', 'nl', catalog).access, 'reads');
    assert.equal(buildPageModel('image-gen', 'en', catalog).access, null);
});

test('events: Nextcloud push events are marked as connector events, Microsoft needs a reachable server', () => {
    const deck = buildPageModel('nextcloud-deck', 'nl', catalog);
    assert.ok(deck.events.length && deck.events.every(e => e.viaConnector));
    assert.ok(deck.events.some(e => e.label === 'Deck-kaart naar een andere lijst verplaatst'));
    const outlook = buildPageModel('outlook', 'en', catalog);
    assert.ok(outlook.eventsNeedPublicUrl);
    assert.equal(buildPageModel('afas-profit', 'en', catalog).events, null);
});
