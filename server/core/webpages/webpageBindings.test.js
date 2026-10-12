/**
 * core/webpages/webpageBindings — de statische scan achter "Doet iets in eigen
 * code".
 *
 * Geen opslag en geen databank: `storageStore`, `webpageStore` en de grants
 * worden gemonkeypatcht. Wat hier vastligt is niet "de parser is slim", maar
 * wat de scan mag BEWEREN: een externe oproep wordt genoemd, een interne niet,
 * en alles wat niet te herleiden viel — een variabele URL, een uitgecommentari-
 * eerde regel, een XHR zonder letterlijk adres, onleesbare bestanden — komt
 * terug als `unresolved` of `scanned:false`, nooit als stilte.
 *
 * Draaien: cd server && node --test --test-force-exit core/webpages/webpageBindings.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const bridgeGrants = require('../../stores/webpage/bridgeGrants');
const storageStore = require('../../stores/storageStore');
const webpageStore = require('../../stores/webpageStore');
const bindings = require('./webpageBindings');

const OWNER = 'u-owner';

function withPatches(patches, fn) {
    const originals = patches.map(([obj, key]) => [obj, key, obj[key]]);
    for (const [obj, key, value] of patches) obj[key] = value;
    return Promise.resolve().then(fn).finally(() => {
        for (const [obj, key, orig] of originals) obj[key] = orig;
    });
}

function withEnv(vars, fn) {
    const originals = Object.entries(vars).map(([k]) => [k, process.env[k]]);
    for (const [k, v] of Object.entries(vars)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    return Promise.resolve().then(fn).finally(() => {
        for (const [k, v] of originals) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    });
}

// ── de scan ───────────────────────────────────────────────────────────

test('a fetch to another host is reported with its host, file and line', () => {
    const js = ['const a = 1;', 'fetch("https://api.stripe.com/v1/charges");'].join('\n');
    const out = bindings.scanOutboundCalls({ js });
    assert.strictEqual(out.externalCount, 1);
    assert.strictEqual(out.calls.length, 1);
    assert.strictEqual(out.calls[0].host, 'api.stripe.com');
    assert.strictEqual(out.calls[0].url, 'https://api.stripe.com/v1/charges');
    assert.strictEqual(out.calls[0].dynamic, false);
    assert.strictEqual(out.calls[0].kind, 'fetch');
    assert.strictEqual(out.calls[0].source, 'script.js');
    assert.strictEqual(out.calls[0].line, 2);
    assert.strictEqual(out.unresolved, 0);
});

test('a relative fetch is internal and is not reported as an outbound call', () => {
    const out = bindings.scanOutboundCalls({ js: 'fetch("/api/webpages-preview/x/ai/chat");' });
    assert.deepStrictEqual(out.calls, []);
    assert.strictEqual(out.externalCount, 0);
    assert.strictEqual(out.internal, 1);
    assert.strictEqual(out.unresolved, 0);
});

test('the installation\'s own configured host counts as internal', async () => {
    await withEnv({ PUBLIC_APP_URL: 'https://pages.example.org', PUBLIC_SHARE_BASE_URL: undefined }, () => {
        const own = bindings.scanOutboundCalls({ js: 'fetch("https://pages.example.org/api/x");' });
        assert.strictEqual(own.externalCount, 0);
        assert.strictEqual(own.internal, 1);
        // …en een andere host op dezelfde box blijft extern.
        const other = bindings.scanOutboundCalls({ js: 'fetch("https://elders.example.net/api/x");' });
        assert.strictEqual(other.externalCount, 1);
    });
});

test('a fetch whose address comes from a variable is unresolved, never silence', () => {
    const out = bindings.scanOutboundCalls({ js: 'const endpoint = base + "/x";\nfetch(endpoint);' });
    assert.deepStrictEqual(out.calls, []);
    assert.strictEqual(out.unresolved, 1);
    assert.strictEqual(out.internal, 0);
});

test('a template literal keeps the host it fixes and marks the rest', () => {
    const out = bindings.scanOutboundCalls({ js: 'fetch(`https://api.vendor.com/v1/${id}`);' });
    assert.strictEqual(out.calls.length, 1);
    assert.strictEqual(out.calls[0].host, 'api.vendor.com');
    assert.strictEqual(out.calls[0].url, 'https://api.vendor.com/v1/…');
    // De automation-scaffold krijgt het deel dat vaststaat, met `dynamic` erbij —
    // een beletselteken hoort nooit in een echte URL terecht te komen.
    assert.strictEqual(out.calls[0].urlPrefix, 'https://api.vendor.com/v1/');
    assert.strictEqual(out.calls[0].dynamic, true);
});

test('a template literal whose host itself is a variable is unresolved', () => {
    const out = bindings.scanOutboundCalls({ js: 'fetch(`${base}/v1/items`);' });
    assert.deepStrictEqual(out.calls, []);
    assert.strictEqual(out.unresolved, 1);
});

test('the // in a URL is not read as a comment', () => {
    const js = 'const u = "https://api.vendor.com/x"; // roept de leverancier\nfetch("https://api.vendor.com/x");';
    const out = bindings.scanOutboundCalls({ js });
    assert.strictEqual(out.calls.length, 1);
    assert.strictEqual(out.calls[0].host, 'api.vendor.com');
    assert.strictEqual(out.unresolved, 0);
});

test('a fetch that only survives in a comment is counted as unchecked, not as absent', () => {
    const out = bindings.scanOutboundCalls({ js: '// fetch("https://api.vendor.com/x");\nconst x = 1;' });
    assert.deepStrictEqual(out.calls, []);
    assert.strictEqual(out.externalCount, 0);
    // Uitgecommentarieerd of door de mini-parser verkeerd gelezen is van buiten
    // niet te onderscheiden — dus "niet gecontroleerd", niet "niets gevonden".
    assert.strictEqual(out.unresolved, 1);
});

test('an XMLHttpRequest with a literal method and address is reported with that method', () => {
    const js = [
        'const xhr = new XMLHttpRequest();',
        'xhr.open("POST", "https://hooks.vendor.com/in");',
        'xhr.send();',
    ].join('\n');
    const out = bindings.scanOutboundCalls({ js });
    assert.strictEqual(out.calls.length, 1);
    assert.strictEqual(out.calls[0].kind, 'xhr');
    assert.strictEqual(out.calls[0].method, 'POST');
    assert.strictEqual(out.calls[0].host, 'hooks.vendor.com');
    assert.strictEqual(out.unresolved, 0);
});

test('an XMLHttpRequest whose address is a variable leaves an unresolved count', () => {
    const js = 'const xhr = new XMLHttpRequest();\nxhr.open(method, target);\nxhr.send();';
    const out = bindings.scanOutboundCalls({ js });
    assert.deepStrictEqual(out.calls, []);
    assert.strictEqual(out.unresolved, 1);
});

test('inline scripts in index.html are scanned with their real line numbers; <script src> is skipped', () => {
    const html = [
        '<html>',
        '<body>',
        '<script src="https://cdn.vendor.com/lib.js"></script>',
        '<script>',
        '  fetch("https://api.vendor.com/x");',
        '</script>',
        '</body>',
    ].join('\n');
    const out = bindings.scanOutboundCalls({ html });
    assert.strictEqual(out.calls.length, 1);
    assert.strictEqual(out.calls[0].source, 'index.html');
    assert.strictEqual(out.calls[0].line, 5);
    // De inhoud van een externe <script src> kan deze scan niet lezen; er wordt
    // dus ook niets over beweerd (geen call, geen unresolved).
    assert.strictEqual(out.unresolved, 0);
});

test('the same address twice is one card with an occurrence count', () => {
    const js = 'fetch("https://api.vendor.com/x");\nfetch("https://api.vendor.com/x");';
    const out = bindings.scanOutboundCalls({ js });
    assert.strictEqual(out.calls.length, 1);
    assert.strictEqual(out.calls[0].occurrences, 2);
    assert.strictEqual(out.externalCount, 1);
});

test('the list of addresses is capped, but the total stays true', () => {
    // De kaartenkolom zegt "en n meer" op basis van externalCount; die mag dus
    // niet meelopen met de afgekapte lijst.
    const js = Array.from({ length: 25 }, (_, i) => `fetch("https://api${i}.vendor.com/x");`).join('\n');
    const out = bindings.scanOutboundCalls({ js });
    assert.strictEqual(out.calls.length, 20);
    assert.strictEqual(out.externalCount, 25);
});

test('data: and blob: are not outbound calls to a host', () => {
    const out = bindings.scanOutboundCalls({ js: 'fetch("data:text/plain,hi");\nfetch(blobUrl);' });
    assert.deepStrictEqual(out.calls, []);
    assert.strictEqual(out.internal, 1);
    assert.strictEqual(out.unresolved, 1);
});

test('classifyUrl never answers "internal" when it cannot tell', () => {
    const hosts = new Set(['pages.example.org']);
    assert.strictEqual(bindings.classifyUrl('', false, hosts).verdict, 'unknown');
    assert.strictEqual(bindings.classifyUrl('ws://api.vendor.com', false, hosts).verdict, 'unknown');
    assert.strictEqual(bindings.classifyUrl('//api.vendor.com/x', false, hosts).verdict, 'external');
    assert.strictEqual(bindings.classifyUrl('api/', true, hosts).verdict, 'unknown');
    assert.strictEqual(bindings.classifyUrl('/api/', true, hosts).verdict, 'internal');
});

// ── het model achter de kolom ─────────────────────────────────────────

function stubs({
    available = true, slots = { html: '', js: '' }, slotsThrow = false,
    extras = [], extrasThrow = false, extraReadThrow = false, extraMissing = false,
    grants = null, grantsThrow = false,
} = {}) {
    return [
        [storageStore, 'isAvailable', () => available],
        [webpageStore, 'readAllSlots', async () => { if (slotsThrow) throw new Error('rustfs down'); return slots; }],
        [webpageStore, 'listExtraFiles', async () => {
            if (extrasThrow) throw new Error('db down');
            return extras.map(e => ({ path: e.path, isText: e.isText !== false, mimeType: 'text/jsx' }));
        }],
        [webpageStore, 'readExtraFile', async ({ path }) => {
            if (extraReadThrow) throw new Error('rustfs down');
            if (extraMissing) return null;
            return { text: extras.find(e => e.path === path)?.text ?? '' };
        }],
        [bridgeGrants, 'getBridgeGrants', async () => {
            if (grantsThrow) throw new Error('db down');
            return grants || { ai: {}, automations: [], integrations: [], tables: [], agent: null };
        }],
    ];
}

test('code that cannot be read is scanned:false — never an empty result', async () => {
    await withPatches(stubs({ available: false }), async () => {
        const out = await bindings.describePageActions({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.code.scanned, false);
        assert.deepStrictEqual(out.code.calls, []);
    });
    await withPatches(stubs({ slotsThrow: true }), async () => {
        const out = await bindings.describePageActions({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.code.scanned, false);
    });
});

test('a readable page without outbound calls is scanned:true with an empty list', async () => {
    await withPatches(stubs({ slots: { html: '<p>hi</p>', js: 'document.title = "x";' } }), async () => {
        const out = await bindings.describePageActions({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.code.scanned, true);
        assert.deepStrictEqual(out.code.calls, []);
        assert.strictEqual(out.code.unresolved, 0);
    });
});

// ── de extra bestanden: waar de meeste pagina's hun code hebben ───────

test('BITE — a react-mui page keeps its whole app in src/, and the scan must read it', async () => {
    // De drie slots zijn leeg (react-mui genereert de html en gebruikt het
    // js-slot niet). Wie alleen readAllSlots leest, meldt hier "niets
    // gevonden" over een pagina die naar een vreemde host post.
    const extras = [
        { path: 'src/main.jsx', text: 'import App from "./App.jsx";' },
        { path: 'src/App.jsx', text: 'export default function App(){\n  fetch("https://hooks.example.com/leak");\n}' },
    ];
    await withPatches(stubs({ slots: { html: '', js: '' }, extras }), async () => {
        const out = await bindings.describePageActions({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.code.scanned, true);
        assert.strictEqual(out.code.calls.length, 1,
            'a fetch in src/App.jsx may not vanish just because it is not in one of the three slots');
        assert.strictEqual(out.code.calls[0].host, 'hooks.example.com');
        assert.strictEqual(out.code.calls[0].source, 'src/App.jsx',
            'the author has to know WHICH file to open');
        assert.strictEqual(out.code.calls[0].line, 2);
    });
});

test('an extra markup file is read for its inline scripts, under its own path', () => {
    const out = bindings.scanOutboundCalls({
        extras: [{ path: 'about.html', text: '<p>hi</p>\n<script>fetch("https://api.vendor.com/x");</script>' }],
    });
    assert.strictEqual(out.externalCount, 1);
    assert.strictEqual(out.calls[0].source, 'about.html');
    assert.strictEqual(out.calls[0].line, 2);
});

test('BITE — extras that cannot be listed make the whole scan unreadable, never empty', async () => {
    await withPatches(stubs({ extrasThrow: true }), async () => {
        const out = await bindings.describePageActions({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.code.scanned, false,
            'half a project read is not a basis for "no calls found"');
    });
});

test('BITE — an extra file whose bytes are gone makes the scan unreadable', async () => {
    const extras = [{ path: 'modules/state.js', text: 'const x = 1;' }];
    await withPatches(stubs({ extras, extraReadThrow: true }), async () => {
        const out = await bindings.describePageActions({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.code.scanned, false);
    });
    await withPatches(stubs({ extras, extraMissing: true }), async () => {
        const out = await bindings.describePageActions({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.code.scanned, false);
    });
});

test('the agent block reports the bound agent and stays internal-only', async () => {
    await withPatches(stubs({ grants: { agent: { agentId: 'ag_1' }, tables: [] } }), async () => {
        const out = await bindings.describePageActions({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.agent.known, true);
        assert.strictEqual(out.agent.agentId, 'ag_1');
        assert.strictEqual(out.agent.internalOnly, true);
        // `supported` stond op false zolang <bf-agent> en <bf-form> niet
        // bestonden. Sinds W4 bestaan ze, en dan is "dit kennen we nog niet"
        // onwaar; het verschil tussen "geen" en "niet gekeken" draagt `scanned`.
        assert.strictEqual(out.agent.supported, true);
        assert.strictEqual(out.forms.supported, true);
        assert.strictEqual(out.forms.scanned, true);
        // Deze pagina heeft geen enkel element, en dat is iets anders dan een
        // pagina waarvan de bestanden niet te lezen waren.
        assert.deepStrictEqual(out.uses.targets.agent, []);
    });
});

test('unreadable grants leave the agent block unknown rather than claiming there is none', async () => {
    await withPatches(stubs({ grantsThrow: true }), async () => {
        const out = await bindings.describePageActions({ webpageId: 'wp1', userId: OWNER });
        assert.strictEqual(out.agent.known, false);
        assert.strictEqual(out.agent.agentId, null);
    });
});
