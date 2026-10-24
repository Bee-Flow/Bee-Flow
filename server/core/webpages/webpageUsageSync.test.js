/**
 * The writer of the usage index for a WEBPAGE (W5 part A).
 *
 * What is fixed here is not "it writes rows", but the three ways in which a reconciler on a
 * shared index silently goes wrong:
 *
 *   1. WIPING ON A FAILED SCAN. `reconcileUsageFor` is delete-then-insert: an empty list is
 *      not "nothing found" but an instruction to throw everything away. If the scan cannot read
 *      the files, then NOTHING may be written — otherwise a fault in the object store would
 *      open the 409 gate on every table beneath it without anything being visible.
 *   2. A KEY THAT MOVES ALONG. `step_id` is half of the primary key; a line number or an
 *      element sequence number would write a new row on every edit and let the index grow until
 *      it means nothing.
 *   3. A DELETED PAGE THAT LEAVES ROWS BEHIND. There is no FK to `webpages`, so only an explicit
 *      purge cleans them up — and a reconcile that no longer finds the page may not write anyway.
 *
 * Plus the reason that the index is wider than the scan: the GATE (`bridge_grants.tables`) is
 * the only route by which `window.beeflowTables` reads, and that route carries no `bf-*` element
 * at all. A page that fetches its rows from its own JS would otherwise be the heaviest user who
 * is listed nowhere.
 *
 * Run: cd server && node --test --test-reporter=tap core/webpages/webpageUsageSync.test.js
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

/** A store that knows one page row. `row: null` = the page does not exist. */
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
 * The real scan, with only the READING replaced. That way every test runs through
 * `scanBfElements` + `collectUses` instead of through a fake result — so a change in the
 * vocabulary reaches here too.
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
 * The authorisation layer that yields the scope of the OWNER.
 *
 * This is the source on which the reconciler has run since the scope no longer comes from
 * `webpages.organization_id`: that column is NULL until a page is published to the org,
 * whereas the tables of an org member are ORG-scoped from their first row. `orgId: null` is
 * therefore a solo account, not "not yet published".
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
 * Catches what would go to the index. `written` determines what syncUsageFor returns.
 *
 * The default is `entries.length` — "everything has landed". That is the happy outcome, and
 * precisely for that reason `written: 0` on a NON-empty list must be run apart: that is how
 * a wrong scope announces itself (the DELETE ran, the INSERT matched nothing), and without
 * that branch it would be called `{ok:true, written:0}`.
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

// ── 1. from two tables to one ─────────────────────────────────────────
//
// The ordinary case, and at once the case that the index exists for: what the page NO
// LONGER binds must also go out. reconcileUsageFor is delete-then-insert, so "out" means here:
// the second table is not in the list that is offered.

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
    // And the vanished table is NOT sent along: it disappears because the
    // reconcile no longer names it, not because someone deletes it separately.
    assert.ok(!after.calls.sync[0].entries.some(e => e.datatableId === 'tbl_b'));
});

test('de sleutel volgt de TABEL, niet de plek in het bestand — idempotent over bewerkingen heen', async () => {
    const one = recordingSync();
    const two = recordingSync();
    await usageSyncModule.reconcileWebpageUsage(PAGE,
        deps({ code: readable({ html: TWO_TABLES }), sync: one }));
    // The same two tables, but moved: other lines, other order, and the second one now sits in
    // an extra file instead of in the html slot. Were `step_id` tied to a line number, a sequence
    // number or a file name, this save would write four rows instead of the same two.
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

// ── 2. a scan that falls over ─────────────────────────────────────────
//
// The core of this entire file. `readable:false` means "unknown", and unknown narrows to
// DOING NOTHING — not to an empty list, because that list would wipe the index and with it the gate.

test('een onleesbare scan schrijft NIETS en laat de rijen staan', async () => {
    const sync = recordingSync();
    const log = silentLog();
    const res = await usageSyncModule.reconcileWebpageUsage(PAGE, deps({ code: UNREADABLE, sync, log }));

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'unreadable-code');
    assert.strictEqual(res.written, 0);
    // Not cleared, not written: no contact at all with the index.
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
    // Cancelling the timer covers only a pass that has not yet fired. This one
    // is already reading: it has seen the page row, and without a safety net it would write the
    // rows back just after the deletion had removed them. A ghost row then holds back the
    // deletion of a table with 409, on behalf of a page nobody can open any more.
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

// ── the gate counts too, not only the code ────────────────────────────

test('een tabel die alleen GEBONDEN is, zonder element, krijgt toch een rij', async () => {
    const sync = recordingSync();
    await usageSyncModule.reconcileWebpageUsage(PAGE, deps({
        row: page({ bridgeGrants: { tables: [{ datatableId: 'tbl_hidden', mode: 'read', columns: ['naam'] }] } }),
        code: readable({ html: '<p>geen enkel bf-element</p>' }),
        sync,
    }));
    // Without this line a page that fetches its rows with
    // beeflowTables.query() is invisible in the index.
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
    // tbl_b is in the code but is not bound: the narrow side.
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
    // But it does not vanish silently: the reconcile counts what it could not
    // point at.
    assert.strictEqual(res.unresolved, 1);
});

test('een adres dat de scan niet kan aanwijzen komt in het LOG — anders is het nul signaal', async () => {
    // The heading promises that `unresolved` is reported. The detached path throws away the
    // return value, so without a log line a page with ten unpointable references yields nothing
    // anyone could look at.
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

// ── the scope ─────────────────────────────────────────────────────────
//
// The sharpest bug that this file guards against, and it is not visible in the result: a reconcile
// with the WRONG scope reports itself as successful. `reconcileUsageFor` locks its INSERT on
// `(scope_kind, scope_id)` of the table, so the DELETE does run and the INSERT matches zero rows —
// `{ok:true, written:0}` — and with that the 409 gate on every named table stands open.
//
// The scope first came from `page.organizationId`. That column is NULL until a page is published to
// the ORG (setWebpagePublished is the only writer; a clone sets it back to null), whereas the tables of
// that same org member are ORG-scoped from their first row. Every unpublished page of an org member
// therefore landed on zero rows. The source is now the OWNER.

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
        // The column says ORG, the authorisation layer says: this owner has none.
        // The authorisation layer wins — the column is a consequence of publishing, not the
        // addressing of tables.
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
    // Offering only the personal scope would silently drop this owner's org tables from
    // the index. Unknown narrows to doing nothing.
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

// ── zero rows on a non-empty list ─────────────────────────────────────
//
// The branch that makes the bug above VISIBLE. Without it the suite stays green while zero rows
// land in production: the test that stays green when you remove the behaviour.

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

// "Never throws" is a promise to the save around it, and that must not depend on whether the
// layer underneath keeps its own promise.

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
