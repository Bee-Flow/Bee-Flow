'use strict';

/**
 * "N acties deze maand" per App Studio-app (APPS-08).
 *
 * Het getal komt uit `ai_usage_log`, waar routes/studioAppsRun.js per
 * actierun een rij wegschrijft. Twee dingen kunnen daar los kapot, en allebei
 * stil:
 *
 *   • de BRON kan aan een kant hernoemd worden (de runtime schrijft
 *     'studio_app_action', de query zoekt iets anders) — dan telt elke app op
 *     nul en oogt het hele scherm dood;
 *   • het FILTER kan naar de kijker verschuiven. Elke rij staat op de
 *     EIGENAAR van de app, dus zodra er `user_id = <viewer>` in de where
 *     komt, ziet iedereen behalve de bouwer nul. Dat is precies de valkuil
 *     die in de bevinding staat, en hij is niet zichtbaar aan het antwoord:
 *     nul is een geldig getal.
 *
 * Run: cd server && node --test stores/usageStore.studioAppRuns.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const usageStore = require('./usageStore');

const RUN_ROUTE = fs.readFileSync(path.join(__dirname, '..', 'routes', 'studioAppsRun.js'), 'utf8');

function fakeDb(rows, capture = []) {
    return {
        async query(sql, params) { capture.push({ sql, params }); return { rows }; },
    };
}

test('the store and the run bridge name the SAME source', () => {
    // Genuinely textual: routes/studioAppsRun.js hardcodes the literal string
    // on purpose, at both its call sites (the 'step' and the 'run' actions),
    // rather than importing usageStore.STUDIO_APP_ACTION_SOURCE — so a store
    // does not need to pull anything from the runtime. There is no shared
    // reference to check by identity; the two literals only have to agree by
    // VALUE, and reading the source is the only way to compare them.
    //
    // Counted, not just matched: `assert.match` only proves ONE call site
    // still says it, so a rename at one and not the other stayed green here.
    assert.strictEqual(usageStore.STUDIO_APP_ACTION_SOURCE, 'studio_app_action');
    const sourceHits = RUN_ROUTE.match(/source: 'studio_app_action'/g) || [];
    const agentIdHits = RUN_ROUTE.match(/agent_id: app\.id/g) || [];
    assert.strictEqual(sourceHits.length, 2,
        'de actierun-route heeft twee actie-eindpunten; allebei moeten hun verbruiksrij onder deze bron wegschrijven');
    assert.strictEqual(agentIdHits.length, 2,
        'allebei de rijen moeten de APP als agent_id dragen — daar telt deze query op');
});

test('counts action runs of the asked apps, and NEVER filters on the viewer', async () => {
    const seen = [];
    const db = fakeDb([{ agent_id: 'app-1', runs: 12 }], seen);
    const out = await usageStore.getStudioAppRunCounts(['app-1', 'app-2'], { db });

    assert.strictEqual(out.get('app-1'), 12);
    assert.strictEqual(out.get('app-2'), 0, 'een app waar niemand op drukte is een feit, geen gat');

    const { sql, params } = seen[0];
    assert.doesNotMatch(sql, /user_id/,
        'de rijen staan op de EIGENAAR: filteren op user_id zet de teller voor elke andere kijker op nul');
    assert.match(sql, /agent_id = ANY\(\$1::text\[\]\)/);
    assert.match(sql, /source = \$2/, 'gewone chats en andere bronnen horen niet in dit getal');
    assert.deepStrictEqual(params, [['app-1', 'app-2'], 'studio_app_action']);
});

test('the window is a real time bound, and it is the calendar month', async () => {
    const seen = [];
    await usageStore.getStudioAppRunCounts(['app-1'], { db: fakeDb([], seen) });
    assert.match(seen[0].sql, /timestamp >= date_trunc\('month', NOW\(\)\)/,
        'zonder tijdgrens telt het getal alles sinds de installatie, niet "deze maand"');
    assert.deepStrictEqual(Object.keys(usageStore.RUN_COUNT_WINDOWS), ['month'],
        'de vensterlijst is gesloten: de waarde is een SQL-fragment');
});

test('an unknown window is refused, never silently answered as a month', async () => {
    const seen = [];
    await assert.rejects(
        () => usageStore.getStudioAppRunCounts(['app-1'], { window: 'week', db: fakeDb([], seen) }),
        /unknown window/,
    );
    await assert.rejects(
        () => usageStore.getStudioAppRunCounts(['app-1'], { window: "x') OR true --", db: fakeDb([], seen) }),
        /unknown window/,
        'het venster is een sleutel in een gesloten lijst, nooit tekst die de query in gaat',
    );
    assert.strictEqual(seen.length, 0, 'een afgewezen venster vraagt de database niets');
});

test('an empty or junk id list asks the database nothing', async () => {
    const seen = [];
    const db = fakeDb([], seen);
    for (const ids of [[], null, undefined, [null, '', false]]) {
        const out = await usageStore.getStudioAppRunCounts(ids, { db });
        assert.strictEqual(out.size, 0);
    }
    assert.strictEqual(seen.length, 0);
});

test('a row for an app nobody asked about is ignored', async () => {
    const db = fakeDb([
        { agent_id: 'app-1', runs: 3 },
        { agent_id: 'someone-elses-app', runs: 99 },
    ]);
    const out = await usageStore.getStudioAppRunCounts(['app-1'], { db });
    assert.deepStrictEqual([...out.entries()], [['app-1', 3]]);
});

test('duplicate ids are asked once and answered once', async () => {
    const seen = [];
    await usageStore.getStudioAppRunCounts(['app-1', 'app-1', 'app-1'], { db: fakeDb([], seen) });
    assert.deepStrictEqual(seen[0].params[0], ['app-1']);
});
