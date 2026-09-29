/**
 * What the Component Designer routes accept, and what they say when they
 * refuse (routes/components.js).
 *
 * Each of these used to answer "Component created successfully" while
 * something else happened:
 *
 *   - a dependency off componentManager's allow-list was written, refused at
 *     install time into a log line, and the component died at run time;
 *   - a VERSION that is a location — a tarball URL, a git remote, `file:`, an
 *     `npm:` alias, a bare `x.tgz` — put an unvetted package under a vetted
 *     name, and npm runs its install scripts on the host;
 *   - `agentEnabled: 'true'` (a string) looked on in the studio and was never
 *     offered to an agent, which reads `=== true`;
 *   - a secure input's misspelled `secrue` flag left its secret default
 *     readable, unredacted, by every reader of GET /:id.
 *
 * What this file pins:
 *
 *   - the 400 NAMES the field (`body.dependencies.lodash`);
 *   - the message is a sentence, including for a field simply left out;
 *   - nothing is written and nothing is installed for a refused request.
 *
 * The two success cases write a throwaway component under components/ and
 * remove it again.
 *
 * Run: cd server && node --test routes/components.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

// Every install and reload lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../auth/permissions': { requireAuth: pass },
    '../core/cms/componentManager': {
        ALLOWED_DEPENDENCIES: new Set(['axios', 'cheerio']),
        getComponents: () => [],
        installComponent: async (id) => { touched.push({ what: 'installComponent', args: [id] }); },
        reloadComponent: async (id) => { touched.push({ what: 'reloadComponent', args: [id] }); },
        removeComponent: (id) => { touched.push({ what: 'removeComponent', args: [id] }); },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:components-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]components\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./components');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

const COMPONENTS_DIR = path.resolve(__dirname, '../../components');
const TEMP_ID = `zz-validation-${process.pid}`;
const TEMP_DIR = path.join(COMPONENTS_DIR, TEMP_ID);
test.after(() => fs.rmSync(TEMP_DIR, { recursive: true, force: true }));

/** What the route WROTE for the throwaway component — its output, not source text. */
function written(file) {
    return JSON.parse(fs.readFileSync(path.join(TEMP_DIR, file), 'utf8'));
}

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            setHeader() { return this; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

const create = (extra) => dispatch({ method: 'POST', url: '/', body: { id: TEMP_ID, name: 'Temp', ...extra } });

test.beforeEach(() => { touched.length = 0; });

test('a dependency off the allow-list is refused by name, before anything is written', async () => {
    const res = await create({ dependencies: { lodash: '^4.17.21' } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /^"lodash" is not a package a component may install \(allowed: axios, cheerio\)\.$/);
    assert.ok(res.body.details.some((d) => d.path === 'body.dependencies.lodash'));
    assert.ok(!fs.existsSync(TEMP_DIR), 'no component directory was created');
    assert.deepStrictEqual(touched, []);
});

test('a version that is a location is refused — the allow-list names packages, npm installs what the spec points at', async () => {
    for (const spec of [
        'https://evil.example/axios-1.0.0.tgz', 'git+https://evil.example/axios.git', 'github:evil/axios',
        'evil/axios', 'file:../../tmp/axios', '../axios', '.', 'npm:evil-pkg@1.0.0', '',
        // No ':' and no '/', and still a location: npm reads these as a tarball beside package.json.
        'evil.tgz', 'axios-1.0.0.tar', 'x.TAR.GZ',
    ]) {
        const res = await create({ dependencies: { axios: spec } });
        assert.strictEqual(res.statusCode, 400, `axios@${JSON.stringify(spec)}`);
        assert.ok(res.body.details.some((d) => d.path === 'body.dependencies.axios'), spec);
    }
    assert.ok(!fs.existsSync(TEMP_DIR));
    assert.deepStrictEqual(touched, []);
});

test('"true" as text is refused, instead of a component that looks enabled and never reaches an agent', async () => {
    const res = await create({ agentEnabled: 'true' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'agentEnabled is true or false.');
    assert.ok(!fs.existsSync(TEMP_DIR));
});

test('a misspelled secure flag is refused, instead of storing the secret where GET /:id shows it', async () => {
    const res = await create({ inputs: { apiKey: { type: 'string', default: 'not-a-real-key', secrue: true } } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path.startsWith('body.inputs.apiKey')));
    assert.ok(!fs.existsSync(TEMP_DIR));
});

test('an id that is not text is refused in words; an id of the wrong shape still gets the handler\'s answer', async () => {
    let res = await dispatch({ method: 'POST', url: '/', body: { id: 42 } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Invalid component ID. Use lowercase letters, numbers, and hyphens only.');

    res = await dispatch({ method: 'POST', url: '/', body: { id: 'Has Space' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Invalid component ID. Use lowercase letters, numbers, and hyphens only.');
    assert.deepStrictEqual(touched, []);
});

test('the studio\'s create, then its whole-form save and its "save as sample", still work', async () => {
    const form = {
        id: TEMP_ID, name: 'Temp', description: 'A throwaway', category: 'Custom',
        inputs: { input: 'string', apiKey: { type: 'string', default: 'not-a-real-key', secure: true } },
        outputs: { output: 'any' },
        dependencies: { axios: '^1.6.0', cheerio: 'latest' },
        code: 'process.stdin.on("end", () => console.log("{}"));',
        agentEnabled: true, directChatEnabled: false,
    };
    let res = await dispatch({ method: 'POST', url: '/', body: form });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(touched, [{ what: 'installComponent', args: [TEMP_ID] }]);
    assert.deepStrictEqual(written('package.json').dependencies, { axios: '^1.6.0', cheerio: 'latest' });

    touched.length = 0;
    res = await dispatch({ method: 'PUT', url: `/${TEMP_ID}`, body: { ...form, name: 'Renamed' } });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(written('component.json').name, 'Renamed');
    assert.strictEqual(written('component.json').agentEnabled, true);

    touched.length = 0;
    res = await dispatch({ method: 'PUT', url: `/${TEMP_ID}`, body: { sampleOutput: { output: 'x' }, outputs: { output: 'string', '': 'string' } } });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(touched, [{ what: 'reloadComponent', args: [TEMP_ID] }]);
});

test('a save whose body names another component is refused, not written over this one', async () => {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    fs.writeFileSync(path.join(TEMP_DIR, 'component.json'), JSON.stringify({ name: 'Temp' }));
    const res = await dispatch({ method: 'PUT', url: `/${TEMP_ID}`, body: { id: 'some-other-component', name: 'Other' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'id_mismatch');
    assert.strictEqual(written('component.json').name, 'Temp');
    assert.deepStrictEqual(touched, []);
});
