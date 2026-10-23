/**
 * One sample page through every path that builds a webpage preview document,
 * pinned by hash: the web editor's preview (agent-hub/src/utils/
 * composeWebpageDocument.js and buildWebpagePreview.js, bundled here with the
 * server's native esbuild standing in for esbuild-wasm) and the server's
 * twins (services/reactBundleServer.js for the public React share and the
 * headless screenshot, services/webpageDraftDocument.js and the live bridges
 * for the phone's draft document).
 *
 * Both sides build these documents from server/shared/webpage/ (the web side
 * through its generated mirror, npm run gen:shared). The hashes were recorded
 * BEFORE the two hand-kept copies were folded into that one module, so a
 * change in any byte the editor preview emits fails here. The server documents
 * are compared without their whole-line `//` comments: their inline scripts
 * now carry the web's comment text (they used to carry an English
 * translation), and only the code the page runs had to stay the same.
 *
 * A deliberate change to a preview document: run this file with
 * PIN_PRINT=1, check the diff is the one you meant, and paste the new hashes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { buildBridgeHeadScripts } from './previewBridges.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const WEB_UTILS = path.join(ROOT, 'agent-hub/src/utils');

const esbuild = require('esbuild');
const reactServer = require('../../services/reactBundleServer.js');
const draft = require('../../services/webpageDraftDocument.js');

const TOKENS = { dbToken: 'tok.en-1', dbApiBase: 'https://api.example/', dbWebpageId: 'wp 1/x' };
const LOGO = 'data:image/png;base64,QUJD';

const SLOTS = {
    html: '<!DOCTYPE html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Hi</h1><img src="img/logo.png"><script src="extra.js"></script><script src="script.js"></script></body></html>',
    css: 'h1{color:red} .a::after{content:"$&"}',
    js: 'console.log("</script>", `${1}`);',
};
const VANILLA_EXTRAS = [
    { path: 'extra.js', isText: true, mimeType: 'text/javascript', content: 'window.x = "$1";' },
    { path: 'img/logo.png', isText: false, mimeType: 'image/png', dataUrl: LOGO },
    { path: 'icon.svg', isText: true, mimeType: 'image/svg+xml', content: '<svg/>' },
];
const REACT_EXTRAS = [
    { path: 'src/main.jsx', isText: true, mimeType: 'text/jsx', content: "import { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\nimport './app.css';\ncreateRoot(document.getElementById('root')).render(<App />);\n" },
    { path: 'src/App.jsx', isText: true, mimeType: 'text/jsx', content: "import Button from '@mui/material/Button';\nimport logo from './assets/logo.png';\nexport default function App() { return <Button><img src={logo} />{'</script>'}</Button>; }\n" },
    { path: 'src/app.css', isText: true, mimeType: 'text/css', content: 'body{margin:0}' },
    { path: 'src/assets/logo.png', isText: false, mimeType: 'image/png', dataUrl: LOGO },
    { path: 'assets/bg.png', isText: false, mimeType: 'image/png', dataUrl: LOGO },
];
const BROKEN_EXTRAS = [{ path: 'src/main.jsx', isText: true, mimeType: 'text/jsx', content: "import x from './missing.jsx';\n" }];

function reactFiles(extras) {
    const files = {};
    const assetMap = {};
    for (const f of extras) {
        if (f.isText) files[f.path] = { isText: true, content: f.content };
        else { files[f.path] = { isText: false, dataUrl: f.dataUrl }; assetMap[f.path] = f.dataUrl; }
    }
    return { files, assetMap };
}

/** The web modules, bundled for node: esbuild-wasm is the native esbuild here. */
async function loadWeb() {
    const entry = `export { default as composeWebpageDocument } from ${JSON.stringify(path.join(WEB_UTILS, 'composeWebpageDocument.ts'))};
export { composeReactPreview } from ${JSON.stringify(path.join(WEB_UTILS, 'buildWebpagePreview.ts'))};`;
    const out = await esbuild.build({
        stdin: { contents: entry, resolveDir: WEB_UTILS, loader: 'js' },
        bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent',
        alias: { '@shared': path.join(ROOT, 'agent-hub/src/shared') },
        plugins: [{
            name: 'native-esbuild',
            setup(build) {
                build.onResolve({ filter: /^esbuild-wasm/ }, (args) => ({ path: args.path, namespace: 'stub' }));
                build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => (args.path.endsWith('?url')
                    ? { contents: 'export default "";', loader: 'js' }
                    : { contents: 'module.exports = Object.assign({}, globalThis.__pinNativeEsbuild, { initialize: async () => {} });', loader: 'js' }));
            },
        }],
    });
    globalThis.__pinNativeEsbuild = esbuild;
    const mod = { exports: {} };
    new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
    return mod.exports;
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
const code = (s) => String(s).split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');

async function renderAll() {
    const web = await loadWeb();
    const live = buildBridgeHeadScripts(TOKENS);
    const react = reactFiles(REACT_EXTRAS);
    const broken = reactFiles(BROKEN_EXTRAS);
    const fixedBuild = async () => ({ code: 'console.log("</script>");' });
    return {
        web: {
            vanillaLive: web.composeWebpageDocument(SLOTS, { extraFiles: VANILLA_EXTRAS, selectionBridge: true, ...TOKENS }),
            vanillaBare: web.composeWebpageDocument(SLOTS, { extraFiles: VANILLA_EXTRAS }),
            vanillaNoHead: web.composeWebpageDocument({ html: '<p>x</p>', css: 'p{}', js: 'go()' }, {}),
            reactLive: await web.composeReactPreview(null, { extraFiles: REACT_EXTRAS, selectionBridge: true, ...TOKENS }),
            reactBroken: await web.composeReactPreview(null, { extraFiles: BROKEN_EXTRAS }),
            reactEmpty: await web.composeReactPreview(null, { extraFiles: [] }),
            reactStreaming: await web.composeReactPreview(null, { extraFiles: [], isStreaming: true }),
        },
        server: {
            bridges: live,
            bridgesOther: buildBridgeHeadScripts({ dbToken: 'a"b</script>', dbApiBase: 'http://10.0.0.2:3101', dbWebpageId: 'wp1' }),
            stub: reactServer.buildStubBridgeScript(),
            stubShare: reactServer.buildStubBridgeScript('reactShare'),
            reactStub: (await reactServer.composeReactDoc({ ...react, build: fixedBuild })).doc,
            reactLive: (await reactServer.composeReactDoc({ ...react, headScripts: live })).doc,
            reactBroken: (await reactServer.composeReactDoc({ ...broken })).buildError,
            reactNoEntry: (await reactServer.composeReactDoc({ files: {} })).buildError,
            vanilla: draft.composeVanillaDocument(SLOTS, { extras: VANILLA_EXTRAS, headScripts: live }),
            vanillaNoHead: draft.composeVanillaDocument({ html: '<p>x</p>', css: 'p{}', js: 'go()' }, { headScripts: live }),
        },
    };
}

const PINNED = {
    web: {
        vanillaLive: '0461d67c81a54039',
        vanillaBare: 'b2451205e8ea0dd8',
        vanillaNoHead: 'ed4f9fd25eb0f7ea',
        reactLive: '454a009b6ce69534',
        reactBroken: '454501693247cced',
        reactEmpty: '5ca6d14a9ca5aba5',
        reactStreaming: '7af19c87d23833d3',
    },
    server: {
        bridges: '88f4546293795ba4',
        bridgesOther: 'ccb7a4c53c53a4f8',
        stub: '3ad39bea7c56dd59',
        stubShare: 'df641a728461e9b9',
        reactStub: '31e77e388446adc5',
        reactLive: '6502850119702001',
        reactBroken: 'f2ea34cc5c718d3a',
        reactNoEntry: '6f571ad5152bc258',
        vanilla: 'ae51233fd9504aec',
        vanillaNoHead: '4abc55dd5e0cf52c',
    },
};

const skip = fs.existsSync(WEB_UTILS) ? false : 'agent-hub is not in this checkout';

test('every preview document is byte for byte what it was', { skip, timeout: 60_000 }, async () => {
    const docs = await renderAll();
    const got = {
        web: Object.fromEntries(Object.entries(docs.web).map(([k, v]) => [k, sha(v)])),
        server: Object.fromEntries(Object.entries(docs.server).map(([k, v]) => [k, sha(code(v))])),
    };
    if (process.env.PIN_PRINT) {
        process.stdout.write(`${JSON.stringify(got, null, 4)}\n`);
        if (process.env.PIN_DUMP) fs.writeFileSync(process.env.PIN_DUMP, JSON.stringify(docs, null, 1));
    }
    assert.deepEqual(got, PINNED);
});
