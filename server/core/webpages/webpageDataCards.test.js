/**
 * core/webpages/webpageDataCards — het kaartenmodel van de Data-tab.
 *
 * Geen databank: grants, principal, runner, usage-index en de slot-lezer worden
 * gemonkeypatcht. Getoetst wordt wat het model BEWEERT: dat "niet gebruikt"
 * alleen wordt gezegd als het te controleren viel, dat een tabel die de
 * eigenaar niet mag lezen zichtbaar blijft als `missing`, en dat een
 * schrijvende routine een waarschuwing oplevert.
 *
 * Draaien: cd server && node --test --test-force-exit core/webpages/webpageDataCards.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const bridgeGrants = require('../../stores/webpage/bridgeGrants');
const datatableAccess = require('../../auth/datatableAccess');
const datatableRuntime = require('../../core/dataEngine/datatableRuntime');
const datatableStore = require('../../stores/datatableStore');
const storageStore = require('../../stores/storageStore');
const webpageStore = require('../../stores/webpageStore');
const cards = require('./webpageDataCards');

const OWNER = 'u-owner';

function withPatches(patches, fn) {
    const originals = patches.map(([obj, key]) => [obj, key, obj[key]]);
    for (const [obj, key, value] of patches) obj[key] = value;
    return Promise.resolve().then(fn).finally(() => {
        for (const [obj, key, orig] of originals) obj[key] = orig;
    });
}

const BINDING = {
    datatableId: 'tbl_1', mode: 'readwrite',
    columns: ['name', 'price'], publicColumns: ['name'],
};

const RESOLVED = {
    table: { id: 'tbl_1', name: 'Rates', key: 'rates', rowCount: 42 },
    grade: 'owner',
    meta: { key: 'rates', fields: [{ key: 'name', label: 'Product' }, { key: 'price', label: 'Price' }] },
};

function stubs({
    tables = [BINDING], slots = { html: '', js: '' }, slotsThrow = false,
    extras = [], extrasThrow = false,
    usage = [], resolveThrow = null, storageAvailable = true,
} = {}) {
    return [
        // De code van de pagina wordt via webpageBindings.readPageCode gelezen,
        // en die vraagt eerst of de opslag er is — zonder deze stub zou elke
        // test in een omgeving zonder RustFS 'onleesbaar' meten.
        [storageStore, 'isAvailable', () => storageAvailable],
        [bridgeGrants, 'getBridgeGrants', async () => ({ ai: {}, automations: [], integrations: [], tables, agent: null })],
        [datatableAccess, 'resolveDatatablePrincipalForUser', async (id) => ({ userId: id, orgId: 'org-1', organizationId: 'org-1', orgRole: null, groupIds: [] })],
        [datatableRuntime, 'resolveForPrincipal', async () => { if (resolveThrow) throw resolveThrow; return RESOLVED; }],
        [datatableStore, 'listUsage', async () => usage],
        [webpageStore, 'readAllSlots', async () => { if (slotsThrow) throw new Error('rustfs down'); return slots; }],
        // De extra bestanden horen bij "de eigen code" van de pagina: een
        // react-mui-project heeft daar zijn hele app staan.
        [webpageStore, 'listExtraFiles', async () => {
            if (extrasThrow) throw new Error('db down');
            return extras.map(e => ({ path: e.path, isText: true, mimeType: 'text/jsx' }));
        }],
        [webpageStore, 'readExtraFile', async ({ path }) => ({ text: extras.find(e => e.path === path)?.text ?? '' })],
    ];
}

test('a bound table becomes a card with its rows and column chips', async () => {
    await withPatches(stubs({ slots: { html: '<bf-table source="tbl_1"></bf-table>', js: '' } }), async () => {
        const out = await cards.buildDataCards({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.tables.length, 1);
        const t = out.tables[0];
        assert.strictEqual(t.name, 'Rates');
        assert.strictEqual(t.rowCount, 42);
        assert.deepStrictEqual(t.columns, ['name', 'price']);
        assert.deepStrictEqual(t.publicColumns, ['name']);
        assert.deepStrictEqual(t.allColumns, [
            { key: 'name', label: 'Product' }, { key: 'price', label: 'Price' },
        ]);
        assert.strictEqual(t.usedInCode, true);
        assert.strictEqual(t.missing, false);
        assert.strictEqual(out.counts.tables, 1);
    });
});

test('BITE — an unreadable code slot makes usedInCode null, never false', async () => {
    await withPatches(stubs({ slotsThrow: true }), async () => {
        const out = await cards.buildDataCards({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.tables[0].usedInCode, null,
            '"not used" is a claim; it may only be made when the files were actually read');
    });
});

test('BITE — storage being down makes usedInCode null, not false', async () => {
    // readAllSlots geeft dan lege strings terug; die zijn niet te onderscheiden
    // van een pagina zonder script, dus de bewering mag niet gedaan worden.
    await withPatches(stubs({ storageAvailable: false }), async () => {
        const out = await cards.buildDataCards({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.tables[0].usedInCode, null);
    });
});

test('BITE — a react-mui page that uses the table from src/ is usedInCode:true, not "unused"', async () => {
    // De slots zijn leeg: react-mui zet de hele app in extra bestanden. Zonder
    // die bestanden krijgt een intensief gebruikte tabel de gestippelde pil
    // "niet gebruikt" — en dat is `false`, dus het driewaardige mechanisme
    // vangt het niet op.
    await withPatches(stubs({
        slots: { html: '', js: '' },
        extras: [{ path: 'src/App.jsx', text: 'const rows = await beeflowTables.query("tbl_1");' }],
    }), async () => {
        const out = await cards.buildDataCards({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.tables[0].usedInCode, true);
    });
});

test('BITE — unreadable extra files make usedInCode null, never false', async () => {
    await withPatches(stubs({ extrasThrow: true }), async () => {
        const out = await cards.buildDataCards({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.tables[0].usedInCode, null);
    });
});

test('a table the page never names is usedInCode:false — that one IS a claim', async () => {
    await withPatches(stubs({ slots: { html: '<p>hello</p>', js: 'console.log(1)' } }), async () => {
        const out = await cards.buildDataCards({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.tables[0].usedInCode, false);
    });
});

test('BITE — a table the owner may no longer read stays visible as missing', async () => {
    const refusal = new datatableRuntime.DatatableRuntimeError(404, 'datatable_not_found', 'Not found');
    await withPatches(stubs({ resolveThrow: refusal }), async () => {
        const out = await cards.buildDataCards({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.tables.length, 1, 'the binding must not silently disappear');
        assert.strictEqual(out.tables[0].missing, true);
        assert.strictEqual(out.tables[0].reason, 'datatable_not_found');
        assert.strictEqual(out.tables[0].name, null);
        // De binding zelf blijft wel zichtbaar, zodat de auteur hem kan opruimen.
        assert.deepStrictEqual(out.tables[0].columns, ['name', 'price']);
    });
});

test('an internal failure to resolve does not leak its message into the card', async () => {
    await withPatches(stubs({ resolveThrow: new Error('pg: no route to host 10.0.0.9') }), async () => {
        const out = await cards.buildDataCards({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.tables[0].reason, 'unavailable');
        assert.strictEqual(/10\.0\.0\.9/.test(JSON.stringify(out)), false);
    });
});

test('feeding routines are folded per automation, widest mode wins, and a writer warns', async () => {
    const usage = [
        { consumerKind: 'automation', automationId: 'auto_1', automationTitle: 'Tarieven beheren', mode: 'read', columns: ['name'], lastRunAt: null },
        { consumerKind: 'automation', automationId: 'auto_1', automationTitle: 'Tarieven beheren', mode: 'write', columns: ['price'], lastRunAt: '2026-09-01T10:00:00.000Z' },
        { consumerKind: 'automation', automationId: 'auto_2', automationTitle: 'Alleen lezen', mode: 'read', columns: ['name'], lastRunAt: null },
        // Andere consumenten (apps, KB's, andere pagina's) horen niet op deze kaart.
        { consumerKind: 'app', automationId: 'app_1', automationTitle: 'Some app', mode: 'readwrite', columns: [], lastRunAt: null },
    ];
    await withPatches(stubs({ usage }), async () => {
        const out = await cards.buildDataCards({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.automations.length, 2);
        const a1 = out.automations.find(a => a.automationId === 'auto_1');
        assert.strictEqual(a1.title, 'Tarieven beheren');
        assert.deepStrictEqual(a1.columns.sort(), ['name', 'price']);
        assert.strictEqual(a1.writes, true);
        assert.strictEqual(a1.lastRunAt, '2026-09-01T10:00:00.000Z');
        assert.strictEqual(out.automations.find(a => a.automationId === 'auto_2').writes, false);

        assert.strictEqual(out.warnings.length, 1);
        assert.deepStrictEqual(out.warnings[0], {
            kind: 'automation_writes_directly',
            automationId: 'auto_1',
            automationTitle: 'Tarieven beheren',
            datatableId: 'tbl_1',
            tableName: 'Rates',
        });
    });
});

test('a page with no table bindings answers empty lists, not nulls', async () => {
    await withPatches(stubs({ tables: [] }), async () => {
        const out = await cards.buildDataCards({ webpageId: 'wp1', userId: OWNER });
        assert.deepStrictEqual(out, {
            tables: [], automations: [], warnings: [], counts: { tables: 0, automations: 0 },
        });
    });
});

test('a broken usage index costs the automation cards, not the table card', async () => {
    const stubList = stubs();
    stubList.push([datatableStore, 'listUsage', async () => { throw new Error('index unavailable'); }]);
    await withPatches(stubList, async () => {
        const out = await cards.buildDataCards({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.tables.length, 1);
        assert.strictEqual(out.automations.length, 0);
    });
});
