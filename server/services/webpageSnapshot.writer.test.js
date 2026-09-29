/**
 * services/webpageSnapshot.writeSnapshot — is de uitklappass ook ECHT AANGESLOTEN?
 *
 * ── WAAROM DEZE TEST NAAST webpageSnapshot.bfelements.test.js STAAT ──
 *
 * Die buurtest bewijst dat de uitklapper werkt: hij roept `expandBfElements` en
 * `sanitizeHtml` met de hand achter elkaar aan. Wat hij NIET kan bewijzen is dat
 * `writeSnapshot` die twee ook werkelijk in die volgorde aanroept — en dat is
 * precies wat er misging: je kon de enige aanroep (`const expanded = await
 * expandBfElements(...)`) vervangen door `const expanded = html;` en alle 15
 * tests bleven groen, plus de reactshare-tests, plus de drifttest. Alles bewees
 * dat de uitklapper werkt; niets bewees dat hij gebruikt wordt.
 *
 * Deze test gaat daarom door de ECHTE writer heen en kijkt naar de BYTES die de
 * opslag in gaan — dezelfde bytes die publicViewer.js aan een anonieme bezoeker
 * serveert.
 *
 * ── EN OOK DE EXTRA BESTANDEN ───────────────────────────────────────
 *
 * Een multi-file vanilla-pagina bestaat uit meer dan `index.html`. `about.html`
 * ging alleen door DOMPurify, en die pakt een onbekend element ZWIJGEND uit: van
 * `<bf-form automation="a1"><input name="email"></bf-form>` bleef een levend
 * ogend invoerveld over zonder ontvanger. Dat is de AVG-kant hiervan: gegevens
 * vragen op een publieke pagina waar niemand ze ophaalt.
 *
 * Draaien: cd server && node --test --test-force-exit services/webpageSnapshot.writer.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// ── de opslag- en pagina-lagen vervangen, vóór de require van de writer ──
const uploads = [];
const kinds = [];

const state = {
    framework: 'vanilla',
    html: '',
    extras: [],          // [{ path, isText, mimeType, text }]
};

const mockWebpageStore = {
    getWebpageRaw: async () => ({ id: 'wp1', userId: 'owner1', settings: { framework: state.framework } }),
    readAllSlots: async () => ({ html: state.html, css: '', js: 'alert(1)' }),
    listExtraFiles: async () => state.extras.map(({ path, isText, mimeType }) => ({ path, isText, mimeType })),
    readExtraFile: async ({ path }) => {
        const f = state.extras.find(e => e.path === path);
        return f ? { bytes: Buffer.from(f.text, 'utf8'), text: f.text, meta: { isText: f.isText } } : null;
    },
};
const mockShareStore = {
    snapshotKey: (shareId, slot) => `slot:${slot}`,
    snapshotExtraKey: (shareId, p) => `extra:${p}`,
    setSnapshotKind: async (shareId, kind) => { kinds.push(kind); },
};
const mockStorageStore = {
    isAvailable: () => true,
    uploadFile: async (key, buf, contentType) => {
        uploads.push({ key, contentType, body: buf.toString('utf8') });
    },
};

const overrides = {
    '../stores/webpageStore': mockWebpageStore,
    '../stores/webpagePublicShareStore': mockShareStore,
    '../stores/storageStore': mockStorageStore,
};
const originalResolve = Module._resolveFilename;
const cacheKey = (name) => `mock-writer-${name}`;
Module._resolveFilename = function (request, parent, ...rest) {
    if (Object.prototype.hasOwnProperty.call(overrides, request)) return cacheKey(request);
    return originalResolve.call(this, request, parent, ...rest);
};
for (const [req, exp] of Object.entries(overrides)) {
    require.cache[cacheKey(req)] = { id: cacheKey(req), exports: exp };
}

const bridgeGrants = require('../stores/webpage/bridgeGrants');
const dtAccess = require('../auth/datatableAccess');
const datatableRuntime = require('../core/dataEngine/datatableRuntime');
const bfElements = require('../core/webpages/bfElements');
const webpageSnapshot = require('./webpageSnapshot');

const BINDING = { datatableId: 'tbl_1', mode: 'read', columns: ['name'], publicColumns: ['name'] };
const META = { key: 'orders', fields: [{ id: 'f1', key: 'name', label: 'Product' }] };

bridgeGrants.getBridgeGrants = async () => ({ ai: {}, automations: [], integrations: [], tables: [BINDING], agent: null });
dtAccess.resolveDatatablePrincipalForUser = async (id) => ({ userId: id, orgId: 'o', organizationId: 'o', orgRole: null, groupIds: [] });
datatableRuntime.resolveForPrincipal = async () => ({ meta: META, grade: 'viewer' });
datatableRuntime.readRows = async (_r, opts) => ({
    rows: [{ name: 'Basic' }], columns: opts.allowColumns, hasMore: false, count: 1, nextCursor: null,
});

const TABLE = bfElements.getBfElement('bf-table');
const BUTTON = bfElements.getBfElement('bf-button');
const FORM = bfElements.getBfElement('bf-form');

async function publish({ html = '', extras = [], framework = 'vanilla' } = {}) {
    uploads.length = 0;
    kinds.length = 0;
    Object.assign(state, { html, extras, framework });
    await webpageSnapshot.writeSnapshot({ shareId: 's1', webpageId: 'wp1', ownerId: 'owner1' });
    return {
        html: (uploads.find(u => u.key === 'slot:html') || {}).body || '',
        reactDoc: (uploads.find(u => u.key === 'slot:reactdoc') || {}).body || '',
        extra: (p) => (uploads.find(u => u.key === `extra:${p}`) || {}).body || '',
    };
}

test('het html-slot gaat ECHT door de uitklappass, niet alleen door de sanitizer', async () => {
    const out = await publish({
        html: `<html><body><${TABLE.tag} source="tbl_1"></${TABLE.tag}>`
            + `<${BUTTON.tag} run="a1">Send</${BUTTON.tag}></body></html>`,
    });
    assert.match(out.html, /<table class="bf-table">/, 'de gebonden tabel is server-side gerenderd');
    assert.ok(out.html.includes('Basic'), 'en er staan rijen in uit publicColumns');
    assert.ok(out.html.includes(BUTTON.surfaces.vanillaSnapshot.notice),
        'de knop meldt zelf dat hij in de gepubliceerde kopie niets doet');
    assert.strictEqual(/<\s*bf-/i.test(out.html), false,
        'geen enkel bf-element haalt de opgeslagen bytes — DOMPurify zou het daar zwijgend uitpakken');
    assert.deepStrictEqual(kinds, ['static']);
});

test('BIJT — zonder de uitklappass blijft er van dezelfde knop alleen het woord over', async () => {
    // Negatieve controle op wat de sanitizer alléén doet. Zonder de pass hierboven
    // is dit wat een bezoeker te zien kreeg: het kale label, geen tag, geen
    // attributen, geen waarschuwing.
    const bare = webpageSnapshot.sanitizeHtml(`<${BUTTON.tag} run="a1">Send</${BUTTON.tag}>`);
    assert.strictEqual(bare.trim(), 'Send');
    assert.ok(!bare.includes(BUTTON.surfaces.vanillaSnapshot.notice));
});

test('een EXTRA html-bestand wordt net zo goed uitgeklapt als index.html', async () => {
    const out = await publish({
        html: '<html><body><h1>Home</h1></body></html>',
        extras: [{
            path: 'about.html',
            isText: true,
            mimeType: 'text/html',
            text: `<h1>Contact</h1><${FORM.tag} automation="a1" submit-label="Send">`
                + '<input name="email" type="email"><textarea name="msg"></textarea>'
                + `</${FORM.tag}><${TABLE.tag} source="tbl_1"></${TABLE.tag}>`,
        }],
    });
    const about = out.extra('about.html');
    assert.ok(about.includes(FORM.surfaces.vanillaSnapshot.notice),
        'het formulier in een extra bestand meldt dat het niet werkt');
    assert.match(about, /<input[^>]*disabled/,
        'en zijn velden zijn zichtbaar uitgeschakeld — anders vraagt een publieke pagina gegevens die '
        + 'niemand ophaalt');
    assert.match(about, /<table class="bf-table">/, 'ook de tabel in een extra bestand is uitgeklapt');
    assert.strictEqual(/<\s*bf-/i.test(about), false);
});

test('een extra bestand dat geen HTML is blijft ongemoeid', async () => {
    const out = await publish({
        html: '<html><body></body></html>',
        extras: [{ path: 'notes.md', isText: true, mimeType: 'text/markdown', text: '# hoi\n<bf-table source="x">' }],
    });
    // Markdown wordt niet gesanitized en dus ook niet uitgeklapt: het wordt
    // getoond om te LEZEN, niet uitgevoerd. Ongemoeid laten is hier eerlijk.
    assert.ok(out.extra('notes.md').includes('<bf-table source="x">'));
});

test('de react-share krijgt de zin van ZIJN plek ingebakken, niet die van het plaatje', async () => {
    const out = await publish({
        framework: 'react-mui',
        extras: [{
            path: 'src/main.jsx',
            isText: true,
            mimeType: 'text/javascript',
            text: "import { createRoot } from 'react-dom/client'; createRoot(document.getElementById('root')).render('hi');",
        }],
    });
    assert.ok(out.reactDoc.length > 0, 'sanity: er is een reactdoc geschreven');
    assert.ok(out.reactDoc.includes('window.beeflowBf'),
        'het eerlijk-falen-mechanisme zit in de INGEBAKKEN stub, dus ook als publieke AI uit staat');
    for (const def of bfElements.BF_ELEMENTS) {
        assert.ok(out.reactDoc.includes(def.surfaces.reactShare.notice),
            `${def.tag} draagt op de share geen zin voor de lezer`);
        assert.ok(!out.reactDoc.includes(def.surfaces.headlessRender.notice),
            `${def.tag} draagt op de share de zin van het PLAATJE — dat zou liegen over wat dit is`);
    }
    assert.deepStrictEqual(kinds, ['react']);
});
