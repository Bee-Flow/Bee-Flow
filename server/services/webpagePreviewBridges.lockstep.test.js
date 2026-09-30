/**
 * The server's preview document is the web's, function for function.
 *
 * services/webpagePreviewBridges.js (the live bridges) and the inliners in
 * services/webpageDraftDocument.js are ports of
 * agent-hub/src/utils/composeWebpageDocument.js, so the phone's preview
 * (GET /api/webpages/:id/draft-document) runs a page exactly as the web
 * editor's preview does. This is a differential test: it evaluates the web's
 * own functions (plain string functions, no imports between them) and runs
 * both on the same inputs. The outputs must be identical.
 *
 * When this fails the WEB side changed: port the change, don't loosen this.
 *
 * Run: cd server && node --test services/webpagePreviewBridges.lockstep.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.resolve(__dirname, '../../agent-hub/src/utils/composeWebpageDocument.js');
const bridges = require('./webpagePreviewBridges');
const draft = require('./webpageDraftDocument');

/** One function's source, from `function name(` to its closing brace at column 0. */
function functionSource(source, name) {
    const from = source.search(new RegExp(`(^|\\n)(export )?function ${name}\\(`));
    assert.ok(from >= 0, `function ${name} not found`);
    const begin = source.indexOf(`function ${name}(`, from);
    const firstLine = source.slice(begin, source.indexOf('\n', begin));
    if (firstLine.trimEnd().endsWith('}')) return firstLine;
    const end = source.indexOf('\n}\n', begin);
    assert.ok(end > begin, `end of ${name} not found`);
    return source.slice(begin, end + 2);
}

const WEB_FUNCTIONS = [
    'escapeRegExp', 'defangScriptClose',
    'buildBeeflowAuthScript', 'buildBeeflowBridgesScript', 'buildBeeflowDbScript', 'buildBridgeHeadScripts',
    'inlineStylesheet', 'inlineScript', 'inlineDataUrl',
];

/**
 * The web's functions, evaluated. They are plain functions over strings with
 * no imports between them, so their source runs as-is in a Function body.
 */
function loadWeb() {
    const source = fs.readFileSync(WEB, 'utf8');
    const body = WEB_FUNCTIONS.map((name) => functionSource(source, name)).join('\n\n');
    return new Function(`${body}\nreturn { ${WEB_FUNCTIONS.join(', ')} };`)();
}

const skip = fs.existsSync(WEB) ? false : 'agent-hub is not in this checkout';

const BRIDGE_INPUTS = [
    { dbToken: 'tok.en-1', dbApiBase: 'https://api.example/', dbWebpageId: 'wp 1/x' },
    { dbToken: 'a"b</script>', dbApiBase: 'http://10.0.0.2:3101', dbWebpageId: 'wp1' },
    { dbToken: '', dbApiBase: 'https://x', dbWebpageId: 'wp1' },
    { dbToken: 't', dbApiBase: '', dbWebpageId: 'wp1' },
];

/**
 * The emitted script minus its whole-line comments: the web's are partly
 * Dutch, the server's English, and only the code the page runs must match.
 */
function code(script) {
    return script.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
}

test('the live bridges produce exactly the web preview\'s scripts', { skip }, () => {
    const web = loadWeb();
    for (const input of BRIDGE_INPUTS) {
        assert.strictEqual(code(bridges.buildBridgeHeadScripts(input)), code(web.buildBridgeHeadScripts(input)));
    }
});

const HTML = [
    '<html><head><link rel="stylesheet" href="style.css"><link href=\'a/b.css\' rel="stylesheet"></head>',
    '<body><img src="img/logo.png"><a href="img/logo.png">x</a><script src="script.js"></script>',
    '<script type="module" src="a/b.js" defer></script></body></html>',
].join('');

test('the inliners produce exactly the web preview\'s document', { skip }, () => {
    const web = loadWeb();
    const ours = draft._internals;
    const cases = [
        ['inlineStylesheet', 'style.css', 'h1{color:$red} $& $1'],
        ['inlineStylesheet', 'a/b.css', ':root{--a:1}'],
        ['inlineScript', 'script.js', 'var s = "</script>"; var t = `${1}$&`;'],
        ['inlineScript', 'a/b.js', 'run()'],
        ['inlineDataUrl', 'img/logo.png', 'data:image/png;base64,QUJD$&'],
        ['inlineDataUrl', 'missing.png', 'data:x'],
    ];
    for (const [fn, target, value] of cases) {
        assert.strictEqual(ours[fn](HTML, target, value), web[fn](HTML, target, value), `${fn}(${target})`);
    }
});

test('the live bridges define every global the web preview defines', () => {
    const doc = bridges.buildBridgeHeadScripts({ dbToken: 't', dbApiBase: 'https://api.example/', dbWebpageId: 'wp 1' });
    for (const name of ['__beeflowAuth', 'beeflowDB', 'beeflowAI', 'beeflowAutomations', 'beeflowIntegrations', 'beeflowTables', 'beeflowApp']) {
        assert.ok(doc.includes(`window.${name} = {`), name);
    }
    assert.ok(doc.includes('"https://api.example" + "/api/webpages-preview/" + "wp%201"'));
    assert.strictEqual(bridges.buildBridgeHeadScripts({ dbToken: '', dbApiBase: 'x', dbWebpageId: 'y' }), '');
});
