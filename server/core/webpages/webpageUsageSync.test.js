/**
 * De schrijver van de usage-index voor een WEBPAGINA (W5 deel A).
 *
 * Wat hier vastligt is niet "hij schrijft rijen", maar de drie manieren waarop
 * een reconciler op een gedeelde index stil fout gaat:
 *
 *   1. WISSEN OP EEN MISLUKTE SCAN. `reconcileUsageFor` is delete-then-insert:
 *      een lege lijst is geen "niets gevonden" maar een opdracht om alles weg
 *      te gooien. Kan de scan de bestanden niet lezen, dan MOET er niets
 *      geschreven worden — anders zet een storing in de objectopslag de
 *      409-poort op elke tabel eronder open zonder dat er iets van te zien is.
 *   2. EEN SLEUTEL DIE MEEBEWEEGT. `step_id` is de halve primaire sleutel; een
 *      regelnummer of een elementvolgnummer zou bij elke bewerking een nieuwe
 *      rij schrijven en de index laten groeien tot hij niets meer betekent.
 *   3. EEN VERWIJDERDE PAGINA DIE RIJEN ACHTERLAAT. Er is geen FK naar
 *      `webpages`, dus alleen een expliciete purge ruimt ze op — en een
 *      reconcile die de pagina niet meer vindt mag niet alsnog schrijven.
 *
 * Plus de reden dat de index breder is dan de scan: de POORT
 * (`bridge_grants.tables`) is de enige weg waarlangs `window.beeflowTables`
 * leest, en die weg draagt geen enkel `bf-*`-element. Een pagina die haar
 * rijen uit eigen JS haalt zou anders de zwaarste gebruiker zijn die nergens
 * staat.
 *
 * Draaien: cd server && node --test --test-reporter=tap core/webpages/webpageUsageSync.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const realBindings = require('./webpageBindings');
const usageSyncModule = require('./webpageUsageSync');

const PAGE = 'wp_1';
const OWNER = 'u_owner';
const ORG = 'org_1';

// ── gereedschap ───────────────────────────────────────────────────────

function silentLog() {
    const lines = { warn: [], log: [] };
    return { warn: (m) => lines.warn.push(String(m)), log: (m) => lines.log.push(String(m)), lines };
}

/** Een store die één paginarij kent. `row: null` = de pagina bestaat niet. */
function pageStore(row, { normalize } = {}) {
    return {
        getWebpageRaw: async () => (typeof row === 'function' ? row() : row),
        // De ECHTE normalizer: hij versmalt mode en columns, en dat versmallen
        // is precies wat de index overneemt.
        normalizeBridgeGrants: normalize
            || require('../../stores/webpage/bridgeGrants').normalizeBridgeGrants,
    };
}

/**
 * De echte scan, met alleen het LEZEN vervangen. Zo loopt elke test door
 * `scanBfElements` + `collectUses` heen in plaats van door een namaakuitslag —
 * een verandering in het vocabulaire komt hier dus ook aan.
 */
function bindingsReading(code) {
    return { ...realBindings, readPageCode: async () => code };
}

function readable({ html = '', css = '', js = '', extras = [] } = {}) {
    return { readable: true, html, css, js, extras };
}

const UNREADABLE = { readable: false, html: '', css: '', js: '', extras: [] };

function fakeDatatableStore() {
    return {
        orgScope: (id) => ({ kind: 'org', id }),
        userScope: (id) => ({ kind: 'user', id }),
    };
}

/**
 * De rechtenlaag die de scope van de EIGENAAR oplevert.
 *
 * Dit is de bron waarop de reconciler draait sinds de scope niet meer uit
 * `webpages.organization_id` komt: die kolom is NULL tot een pagina naar de org
 * wordt gepubliceerd, terwijl de tabellen van een org-lid vanaf hun eerste rij
 * ORG-scoped zijn. `orgId: null` is dus een solo-account, niet "nog niet
 * gepubliceerd".
 */
function fakeAccess({ orgId = null, identityError = null, throws = false } = {}) {
    const dt = fakeDatatableStore();
    return {
        resolveDatatablePrincipalForUser: async (userId) => {
            if (throws) throw new Error('user store down');
            return { userId, orgId, organizationId: orgId, identityError };
        },
        datatableScopesFor: (p) => {
            const out = [];
            if (p?.orgId) out.push(dt.orgScope(p.orgId));
            if (p?.userId) out.push(dt.userScope(p.userId));
            return out;
        },
    };
}

/**
 * Vangt wat er naar de index zou gaan. `written` bepaalt wat syncUsageFor
 * teruggeeft.
 *
 * De standaard is `entries.length` — "alles is geland". Dat is de gelukkige
 * uitkomst, en juist daarom moet `written: 0` bij een NIET-lege lijst apart
 * worden gedraaid: dat is hoe een verkeerde scope zich meldt (de DELETE liep,
 * de INSERT matchte niets), en zonder die tak heet dat `{ok:true, written:0}`.
 */
function recordingSync({ written = null } = {}) {
    const calls = { sync: [], purge: [] };
    return {
        calls,
        syncUsageFor: async (kind, id, scope, entries, opts) => {
            calls.sync.push({ kind, id, scope, entries, opts });
            return written === null ? entries.length : written;
        },
        purgeUsageFor: async (kind, id, opts) => {
            calls.purge.push({ kind, id, opts });
            return 1;
        },
    };
}

function page(overrides = {}) {
    return {
        id: PAGE,
        userId: OWNER,
        organizationId: null,
        bridgeGrants: { ai: {}, automations: [], integrations: [], tables: [], agent: null },
        ...overrides,
    };
}

function deps({
    row = page(), code = readable(), sync = recordingSync(), log = silentLog(), access = fakeAccess(),
} = {}) {
    return {
        webpageStore: pageStore(row),
        datatableStore: fakeDatatableStore(),
        datatableAccess: access,
        webpageBindings: bindingsReading(code),
        usageSync: sync,
        log,
    };
}

const TWO_TABLES = '<bf-table source="tbl_a"></bf-table>\n<bf-stat source="tbl_b" agg="count"></bf-stat>';
const ONE_TABLE = '<bf-table source="tbl_a"></bf-table>';

// ── 1. van twee tabellen naar één ─────────────────────────────────────
//
// Het gewone geval, en meteen het geval dat de index bestaat: wat de pagina
// NIET meer bindt, moet er ook uit. reconcileUsageFor is delete-then-insert, dus
// "eruit" betekent hier: de tweede tabel zit niet meer in de lijst die wordt
// aangeboden.

test('twee gebonden tabellen leveren twee rijen, met een sleutel per tabel', async () => {
    const sync = recordingSync();
    const res = await usageSyncModule.reconcileWebpageUsage(PAGE,
        deps({ code: readable({ html: TWO_TABLES }), sync }));

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.reason, 'reconciled');
    assert.strictEqual(sync.calls.sync.length, 1);
    const call = sync.calls.sync[0];
    assert.strictEqual(call.kind, 'webpage');
    assert.strictEqual(call.id, PAGE);
    assert.deepStrictEqual(call.entries.map(e => e.datatableId).sort(), ['tbl_a', 'tbl_b']);
    assert.deepStrictEqual(call.entries.map(e => e.stepId).sort(), ['dt:tbl_a', 'dt:tbl_b']);
});

test('een pagina die van twee tabellen naar één gaat, biedt nog maar één rij aan', async () => {
    const before = recordingSync();
    await usageSyncModule.reconcileWebpageUsage(PAGE, deps({ code: readable({ html: TWO_TABLES }), sync: before }));
    assert.strictEqual(before.calls.sync[0].entries.length, 2);

    // Dezelfde pagina, de tweede tabel is uit de code gehaald.
    const after = recordingSync();
    const res = await usageSyncModule.reconcileWebpageUsage(PAGE, deps({ code: readable({ html: ONE_TABLE }), sync: after }));

    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(after.calls.sync[0].entries.map(e => e.datatableId), ['tbl_a']);
    // En de verdwenen tabel wordt NIET meegestuurd: hij verdwijnt doordat de
    // reconcile hem niet meer noemt, niet doordat iemand hem apart wist.
    assert.ok(!after.calls.sync[0].entries.some(e => e.datatableId === 'tbl_b'));
});

test('de sleutel volgt de TABEL, niet de plek in het bestand — idempotent over bewerkingen heen', async () => {
    const one = recordingSync();
    const two = recordingSync();
    await usageSyncModule.reconcileWebpageUsage(PAGE,
        deps({ code: readable({ html: TWO_TABLES }), sync: one }));
    // Dezelfde twee tabellen, maar verplaatst: andere regels, andere volgorde,
    // en de tweede staat nu in een extra bestand in plaats van in het html-slot.
    // Zou `step_id` aan een regelnummer, een volgnummer of een bestandsnaam
    // hangen, dan schreef deze save vier rijen in plaats van dezelfde twee.
    await usageSyncModule.reconcileWebpageUsage(PAGE, deps({
        code: readable({
            html: '\n\n\n<div>\n  <bf-table source="tbl_a"></bf-table>\n</div>',
            extras: [{ path: 'src/Widgets.jsx', text: '\n\n<bf-stat source="tbl_b" agg="count" />' }],
        }),
        sync: two,
    }));
    const sortById = (entries) => [...entries].sort((a, b) => a.datatableId.localeCompare(b.datatableId));
    assert.deepStrictEqual(sortById(one.calls.sync[0].entries), sortById(two.calls.sync[0].entries));
});

test('tien elementen op dezelfde tabel leveren één rij, niet tien', async () => {
    const sync = recordingSync();
    const html = Array.from({ length: 10 }, () => '<bf-table source="tbl_a"></bf-table>').join('\n');
    await usageSyncModule.reconcileWebpageUsage(PAGE, deps({ code: readable({ html }), sync }));
    assert.deepStrictEqual(sync.calls.sync[0].entries, [
        { datatableId: 'tbl_a', stepId: 'dt:tbl_a', mode: 'read', columns: [] },
    ]);
});

test('een element in een EXTRA bestand telt mee — een react-app heeft geen html-slot', async () => {
    const sync = recordingSync();
    await usageSyncModule.reconcileWebpageUsage(PAGE, deps({
        code: readable({ extras: [{ path: 'src/App.jsx', text: 'return <bf-table source="tbl_x" />;' }] }),
        sync,
    }));
    assert.deepStrictEqual(sync.calls.sync[0].entries.map(e => e.datatableId), ['tbl_x']);
});

// ── 2. een scan die omvalt ────────────────────────────────────────────
//
// De kern van dit hele bestand. `readable:false` betekent "onbekend", en
// onbekend versmalt naar NIETS DOEN — niet naar een lege lijst, want die lijst
// wist de index en daarmee de poort.

test('een onleesbare scan schrijft NIETS en laat de rijen staan', async () => {
    const sync = recordingSync();
    const log = silentLog();
    const res = await usageSyncModule.reconcileWebpageUsage(PAGE, deps({ code: UNREADABLE, sync, log }));

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'unreadable-code');
    assert.strictEqual(res.written, 0);
    // Niet gewist, niet geschreven: geen enkele aanraking van de index.
    assert.strictEqual(sync.calls.sync.length, 0, 'een mislukte scan mag de reconciler niet bereiken');
    assert.strictEqual(sync.calls.purge.length, 0, 'een mislukte scan is geen verwijderde pagina');
});

test('een onleesbare scan ZEGT het — stil overslaan is het gevaar', async () => {
    const log = silentLog();
    await usageSyncModule.reconcileWebpageUsage(PAGE, deps({ code: UNREADABLE, log }));
    assert.strictEqual(log.lines.warn.length, 1);
    assert.match(log.lines.warn[0], /left as-is/);
    assert.match(log.lines.warn[0], new RegExp(PAGE));
});

test('een scan die GOOIT is hetzelfde geval als een scan die niets kon lezen', async () => {
    const sync = recordingSync();
    const d = deps({ sync });
    d.webpageBindings = { ...realBindings, readPageCode: async () => { throw new Error('rustfs down'); } };
    const res = await usageSyncModule.reconcileWebpageUsage(PAGE, d);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'unreadable-code');
    assert.strictEqual(sync.calls.sync.length, 0);
});

test('een onleesbare PAGINARIJ is geen verdwenen pagina — niets wissen, niets schrijven', async () => {
    const sync = recordingSync();
    const d = deps({ sync });
    d.webpageStore = { getWebpageRaw: async () => { throw new Error('db down'); } };
    const res = await usageSyncModule.reconcileWebpageUsage(PAGE, d);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'unreadable-page');
    assert.strictEqual(sync.calls.sync.length, 0);
    assert.strictEqual(sync.calls.purge.length, 0, 'een databasehik mag de index niet opruimen');
});

test('een LEGE maar leesbare pagina schrijft wél — leeg is een antwoord, onleesbaar niet', async () => {
    const sync = recordingSync();
    const res = await usageSyncModule.reconcileWebpageUsage(PAGE, deps({ code: readable({ html: '<p>hi</p>' }), sync }));
    assert.strictEqual(res.ok, true);
    assert.strictEqual(sync.calls.sync.length, 1);
    assert.deepStrictEqual(sync.calls.sync[0].entries, []);
});

// ── 3. een verwijderde pagina ─────────────────────────────────────────

test('purgeWebpageUsage ruimt de rijen van de pagina op, gesleuteld op de SOORT', async () => {
    const sync = recordingSync();
    const n = await usageSyncModule.purgeWebpageUsage(PAGE, { usageSync: sync });
    assert.strictEqual(n, 1);
    assert.strictEqual(sync.calls.purge.length, 1);
    assert.strictEqual(sync.calls.purge[0].kind, 'webpage');
    assert.strictEqual(sync.calls.purge[0].id, PAGE);
});

test('een reconcile op een pagina die niet meer bestaat RUIMT OP in plaats van te schrijven', async () => {
    const sync = recordingSync();
    const res = await usageSyncModule.reconcileWebpageUsage(PAGE, deps({ row: null, sync }));
    assert.strictEqual(res.reason, 'no-page');
    assert.strictEqual(sync.calls.sync.length, 0, 'er valt niets te indexeren voor een pagina die weg is');
    assert.strictEqual(sync.calls.purge.length, 1);
});

test('een purge TIJDENS een lopende pass laat die pass niet alsnog schrijven', async () => {
    // De timer afzeggen dekt alleen een pass die nog niet gevuurd heeft. Deze
    // is al aan het lezen: hij heeft de paginarij nog gezien, en zou zonder
    // vangnet de rijen terugzetten vlak nadat de verwijdering ze weghaalde.
    // Een spookrij houdt daarna de verwijdering van een tabel met 409 tegen
    // namens een pagina die niemand meer kan openen.
    const sync = recordingSync();
    let releaseRead;
    const held = new Promise((r) => { releaseRead = r; });
    const d = deps({ code: readable({ html: ONE_TABLE }), sync });
    d.webpageBindings = {
        ...realBindings,
        readPageCode: async () => { await held; return readable({ html: ONE_TABLE }); },
    };

    const pass = usageSyncModule.reconcileWebpageUsage(PAGE, d);
    await usageSyncModule.purgeWebpageUsage(PAGE, { usageSync: sync });   // de pagina wordt verwijderd
    releaseRead();
    const res = await pass;

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'superseded');
    assert.strictEqual(sync.calls.sync.length, 0, 'een pass die door een purge is ingehaald mag niet schrijven');
    assert.strictEqual(sync.calls.purge.length, 1);
});

test('purgeWebpageUsage zegt een wachtende reconcile af — anders schrijft die de rijen terug', async () => {
    const sync = recordingSync();
    usageSyncModule.reconcileWebpageUsageDetached(PAGE, { ...deps({ sync }), delayMs: 10 });
    const cancelled = await usageSyncModule.purgeWebpageUsage(PAGE, { usageSync: sync });
    assert.strictEqual(cancelled, 1);
    await new Promise(r => setTimeout(r, 40));
    assert.strictEqual(sync.calls.sync.length, 0, 'de afgezegde pass mag niet alsnog schrijven');
});

// ── de poort telt mee, niet alleen de code ────────────────────────────

test('een tabel die alleen GEBONDEN is, zonder element, krijgt toch een rij', async () => {
    const sync = recordingSync();
    await usageSyncModule.reconcileWebpageUsage(PAGE, deps({
        row: page({ bridgeGrants: { tables: [{ datatableId: 'tbl_hidden', mode: 'read', columns: ['naam'] }] } }),
        code: readable({ html: '<p>geen enkel bf-element</p>' }),
        sync,
    }));
    // Zonder deze regel is een pagina die haar rijen met
    // beeflowTables.query() ophaalt onzichtbaar in de index.
    assert.deepStrictEqual(sync.calls.sync[0].entries, [
        { datatableId: 'tbl_hidden', stepId: 'dt:tbl_hidden', mode: 'read', columns: ['naam'] },
    ]);
});

test('mode en columns komen uit de BINDING — een element noemt geen kolommen', async () => {
    const sync = recordingSync();
    await usageSyncModule.reconcileWebpageUsage(PAGE, deps({
        row: page({
            bridgeGrants: { tables: [{ datatableId: 'tbl_a', mode: 'readwrite', columns: ['naam', 'email'] }] },
        }),
        code: readable({ html: TWO_TABLES }),
        sync,
    }));
    const byId = Object.fromEntries(sync.calls.sync[0].entries.map(e => [e.datatableId, e]));
    assert.deepStrictEqual(byId.tbl_a, {
        datatableId: 'tbl_a', stepId: 'dt:tbl_a', mode: 'readwrite', columns: ['naam', 'email'],
    });
    // tbl_b staat wel in de code maar is niet gebonden: de smalle kant.
    assert.deepStrictEqual(byId.tbl_b, {
        datatableId: 'tbl_b', stepId: 'dt:tbl_b', mode: 'read', columns: [],
    });
});

test('een binding die de pagina in haar code NIET noemt, en een element dat niet gebonden is — allebei één rij', async () => {
    const sync = recordingSync();
    await usageSyncModule.reconcileWebpageUsage(PAGE, deps({
        row: page({ bridgeGrants: { tables: [{ datatableId: 'tbl_bound', mode: 'read', columns: [] }] } }),
        code: readable({ html: '<bf-table source="tbl_incode"></bf-table>' }),
        sync,
    }));
    assert.deepStrictEqual(
        sync.calls.sync[0].entries.map(e => e.datatableId).sort(),
        ['tbl_bound', 'tbl_incode'],
    );
});

test('een adres dat de pagina ter plekke bouwt levert GEEN verzonnen rij op', async () => {
    const sync = recordingSync();
    const res = await usageSyncModule.reconcileWebpageUsage(PAGE, deps({
        code: readable({ extras: [{ path: 'src/App.jsx', text: '<bf-table source={id} />' }] }),
        sync,
    }));
    assert.deepStrictEqual(sync.calls.sync[0].entries, []);
    // Maar hij verdwijnt niet in stilte: de reconcile telt wat hij niet
    // kon aanwijzen.
    assert.strictEqual(res.unresolved, 1);
});

test('een adres dat de scan niet kan aanwijzen komt in het LOG — anders is het nul signaal', async () => {
    // De kop belooft dat `unresolved` wordt gemeld. Het detached pad gooit de
    // returnwaarde weg, dus zonder een logregel levert een pagina met tien
    // onaanwijsbare verwijzingen niets op waar iemand naar kan kijken.
    const log = silentLog();
    await usageSyncModule.reconcileWebpageUsage(PAGE, deps({
        code: readable({ extras: [{ path: 'src/App.jsx', text: '<bf-table source={id} />' }] }),
        log,
    }));
    assert.strictEqual(log.lines.warn.length, 1);
    assert.match(log.lines.warn[0], /could not resolve/);
});

test('een geslaagde pass ZONDER onaanwijsbare verwijzingen zegt niets — geen ruis per save', async () => {
    const log = silentLog();
    await usageSyncModule.reconcileWebpageUsage(PAGE, deps({ code: readable({ html: ONE_TABLE }), log }));
    assert.deepStrictEqual(log.lines.warn, []);
});

test('uitgecommentarieerde code is geen koppeling', async () => {
    const sync = recordingSync();
    await usageSyncModule.reconcileWebpageUsage(PAGE, deps({
        code: readable({ html: '<!-- <bf-table source="tbl_old"></bf-table> -->' }),
        sync,
    }));
    assert.deepStrictEqual(sync.calls.sync[0].entries, []);
});

// ── de scope ──────────────────────────────────────────────────────────
//
// De scherpste bug die dit bestand bewaakt, en hij is niet zichtbaar aan de
// uitslag: een reconcile met de VERKEERDE scope meldt zich als geslaagd.
// `reconcileUsageFor` grendelt zijn INSERT op `(scope_kind, scope_id)` van de
// tabel, dus de DELETE loopt wél en de INSERT matcht nul rijen — `{ok:true,
// written:0}` — en daarmee staat de 409-poort op elke genoemde tabel open.
//
// De scope kwam eerst uit `page.organizationId`. Die kolom is NULL tot een
// pagina naar de ORG wordt gepubliceerd (setWebpagePublished is de enige
// schrijver; een kloon zet hem terug op null), terwijl de tabellen van datzelfde
// org-lid ORG-scoped zijn vanaf hun eerste rij. Elke niet-gepubliceerde pagina
// van een org-lid landde dus op nul rijen. De bron is nu de EIGENAAR.

test('een pagina van een ORG-LID wordt onder de org-scope geïndexeerd — óók als zij nooit is gepubliceerd', async () => {
    const sync = recordingSync();
    await usageSyncModule.reconcileWebpageUsage(PAGE, deps({
        // Precies de productiestand: de kolom is leeg, de eigenaar zit in een org.
        row: page({ organizationId: null }),
        access: fakeAccess({ orgId: ORG }),
        code: readable({ html: ONE_TABLE }),
        sync,
    }));
    const scopes = sync.calls.sync[0].scope;
    assert.ok(Array.isArray(scopes), 'de scope reist als lijst, zodat één pass beide scopes dekt');
    assert.deepStrictEqual(scopes[0], { kind: 'org', id: ORG });
});

test('een pagina bindt zowel een ORG-tabel als een persoonlijke — beide scopes gaan mee', async () => {
    const sync = recordingSync();
    await usageSyncModule.reconcileWebpageUsage(PAGE, deps({
        access: fakeAccess({ orgId: ORG }),
        code: readable({ html: TWO_TABLES }),
        sync,
    }));
    // Eén scope zou hier de helft van de bindingen stil laten vallen: welke
    // helft hangt ervan af in welke scope de tabel toevallig leeft.
    assert.deepStrictEqual(sync.calls.sync[0].scope, [
        { kind: 'org', id: ORG },
        { kind: 'user', id: OWNER },
    ]);
});

test('een SOLO-account (geen organisatie) valt terug op zijn persoonlijke tabellen', async () => {
    const sync = recordingSync();
    await usageSyncModule.reconcileWebpageUsage(PAGE, deps({ code: readable({ html: ONE_TABLE }), sync }));
    assert.deepStrictEqual(sync.calls.sync[0].scope, [{ kind: 'user', id: OWNER }]);
});

test('de scope komt NIET uit organization_id — een gepubliceerde pagina van een solo-account blijft persoonlijk', async () => {
    const sync = recordingSync();
    await usageSyncModule.reconcileWebpageUsage(PAGE, deps({
        // De kolom zegt ORG, de rechtenlaag zegt: deze eigenaar heeft er geen.
        // De rechtenlaag wint — de kolom is een gevolg van publiceren, niet de
        // adressering van tabellen.
        row: page({ organizationId: ORG }),
        access: fakeAccess({ orgId: null }),
        code: readable({ html: ONE_TABLE }),
        sync,
    }));
    assert.deepStrictEqual(sync.calls.sync[0].scope, [{ kind: 'user', id: OWNER }]);
});

test('zonder eigenaar wordt er niets geschreven — een halve scope wist de index', async () => {
    const sync = recordingSync();
    const res = await usageSyncModule.reconcileWebpageUsage(PAGE, deps({
        row: page({ userId: null }),
        code: readable({ html: ONE_TABLE }),
        sync,
    }));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'no-scope');
    assert.strictEqual(sync.calls.sync.length, 0);
});

test('een rechtenlaag die de organisatie niet kon lezen gokt niet op de persoonlijke scope', async () => {
    const sync = recordingSync();
    const res = await usageSyncModule.reconcileWebpageUsage(PAGE, deps({
        access: fakeAccess({ identityError: 'the groups could not be read' }),
        code: readable({ html: ONE_TABLE }),
        sync,
    }));
    // Alleen de persoonlijke scope aanbieden zou de org-tabellen van deze
    // eigenaar stil uit de index laten vallen. Onbekend versmalt naar niets doen.
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'no-scope');
    assert.strictEqual(sync.calls.sync.length, 0);
});

test('een onleesbare rechtenlaag valt terug op de kolom als die iets wéét — nooit op een gok', async () => {
    const sync = recordingSync();
    await usageSyncModule.reconcileWebpageUsage(PAGE, deps({
        row: page({ organizationId: ORG }),
        access: fakeAccess({ throws: true }),
        code: readable({ html: ONE_TABLE }),
        sync,
    }));
    assert.deepStrictEqual(sync.calls.sync[0].scope, [
        { kind: 'org', id: ORG },
        { kind: 'user', id: OWNER },
    ]);
});

// ── nul rijen op een niet-lege lijst ──────────────────────────────────
//
// De tak die de bug hierboven ZICHTBAAR maakt. Zonder hem blijft de suite groen
// terwijl er in productie nul rijen landen: de test die groen blijft als je de
// werking weghaalt.

test('een niet-lege lijst die NUL rijen schrijft is een MISLUKTE reconcile, geen lege', async () => {
    const sync = recordingSync({ written: 0 });
    const log = silentLog();
    const res = await usageSyncModule.reconcileWebpageUsage(PAGE,
        deps({ code: readable({ html: TWO_TABLES }), sync, log }));

    assert.strictEqual(res.ok, false, 'twee bindingen en nul rijen mag nooit ok:true heten');
    assert.strictEqual(res.reason, 'not-indexed');
    assert.strictEqual(res.written, 0);
    assert.strictEqual(sync.calls.sync[0].entries.length, 2, 'de lijst werd wél aangeboden');
    assert.strictEqual(log.lines.warn.length, 1);
    assert.match(log.lines.warn[0], /nothing indexed/);
});

test('een LEGE lijst die nul rijen schrijft is gewoon geslaagd — leeg is een antwoord', async () => {
    const sync = recordingSync({ written: 0 });
    const res = await usageSyncModule.reconcileWebpageUsage(PAGE,
        deps({ code: readable({ html: '<p>niets</p>' }), sync }));
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.reason, 'reconciled');
});

test('de EIGENAAR leest de bestanden, niet de aanroeper', async () => {
    const seen = [];
    const d = deps({ row: page({ userId: 'u_new_owner' }), code: readable({ html: ONE_TABLE }) });
    d.webpageBindings = {
        ...realBindings,
        readPageCode: async (userId, webpageId) => { seen.push([userId, webpageId]); return readable({ html: ONE_TABLE }); },
    };
    await usageSyncModule.reconcileWebpageUsage(PAGE, d);
    assert.deepStrictEqual(seen, [['u_new_owner', PAGE]]);
});

// ── het pad dat de routes gebruiken ───────────────────────────────────

test('reconcileWebpageUsageDetached gooit nooit en laat de save niet wachten', async () => {
    const d = deps({ code: UNREADABLE });
    d.webpageStore = { getWebpageRaw: async () => { throw new Error('boom'); } };
    d.delayMs = 0;
    assert.doesNotThrow(() => usageSyncModule.reconcileWebpageUsageDetached(PAGE, d));
    await new Promise(r => setTimeout(r, 20));
});

test('een reeks saves binnen het venster kost ÉÉN scan', async () => {
    const sync = recordingSync();
    const d = { ...deps({ code: readable({ html: ONE_TABLE }), sync }), delayMs: 15 };
    for (let i = 0; i < 5; i++) usageSyncModule.reconcileWebpageUsageDetached(PAGE, d);
    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(sync.calls.sync.length, 1, 'vijf saves in het venster horen één pass op te leveren');
});

test('een save NA het venster krijgt een eigen pass — de debounce mag niets laten vallen', async () => {
    const sync = recordingSync();
    const d = { ...deps({ code: readable({ html: ONE_TABLE }), sync }), delayMs: 5 };
    usageSyncModule.reconcileWebpageUsageDetached(PAGE, d);
    await new Promise(r => setTimeout(r, 40));
    usageSyncModule.reconcileWebpageUsageDetached(PAGE, d);
    await new Promise(r => setTimeout(r, 40));
    assert.strictEqual(sync.calls.sync.length, 2);
});

test('zonder pagina-id gebeurt er niets — geen purge op een lege sleutel', async () => {
    const sync = recordingSync();
    const res = await usageSyncModule.reconcileWebpageUsage('', { usageSync: sync, log: silentLog() });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(await usageSyncModule.purgeWebpageUsage('', { usageSync: sync }), 0);
    assert.strictEqual(sync.calls.purge.length, 0);
    assert.strictEqual(sync.calls.sync.length, 0);
});

test('een reconcile die zelf omvalt meldt zich als mislukt, niet als leeg', async () => {
    const sync = recordingSync({ written: -1 });
    const res = await usageSyncModule.reconcileWebpageUsage(PAGE,
        deps({ code: readable({ html: ONE_TABLE }), sync }));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'failed');
});

// "Gooit nooit" is een belofte aan de save eromheen, en die mag niet afhangen
// van de vraag of de laag eronder zijn eigen belofte nakomt.

test('een indexlaag die GOOIT laat de reconcile niet gooien', async () => {
    const d = deps({ code: readable({ html: ONE_TABLE }) });
    d.usageSync = { syncUsageFor: async () => { throw new Error('pg down'); }, purgeUsageFor: async () => 0 };
    const res = await usageSyncModule.reconcileWebpageUsage(PAGE, d);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'failed');
});

test('een purge die GOOIT laat de verwijdering niet omvallen', async () => {
    const log = silentLog();
    const n = await usageSyncModule.purgeWebpageUsage(PAGE, {
        usageSync: { purgeUsageFor: async () => { throw new Error('pg down'); } },
        log,
    });
    assert.strictEqual(n, 0);
    assert.strictEqual(log.lines.warn.length, 1);
});
