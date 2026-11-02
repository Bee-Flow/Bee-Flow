// @typecheck
/**
 * Public viewer: the content document and its extras stay at an opaque origin
 * even when opened as a top-level page (CSP sandbox, never allow-same-origin),
 * extras that are not rendered inline are downloads, and the e-mailed magic
 * link is built on the configured base, never on the request's Host header.
 *
 * Run: node --test routes/publicViewer.sandbox.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.NODE_ENV = 'test';

// sendServiceEmail is destructured when publicViewer loads: stub it first.
const emailService = require('../utils/emailService');
/** @type {any[]} */
const sentMails = [];
emailService.sendServiceEmail = /** @type {any} */ (async (/** @type {any} */ mail) => { sentMails.push(mail); });

const publicShareStore = require('../stores/webpagePublicShareStore');
const publicShareToken = require('../auth/publicShareToken');
const webpageSnapshot = require('../services/webpageSnapshot');
const webpageStore = require('../stores/webpageStore');
const userStore = require('../stores/userStore');
const viewer = require('./publicViewer');

/** @param {any[]} patches @param {() => Promise<void>} fn */
function withPatches(patches, fn) {
    const originals = patches.map(([obj, key]) => [obj, key, obj[key]]);
    for (const [obj, key, value] of patches) obj[key] = value;
    return fn().finally(() => {
        for (const [obj, key, orig] of originals) obj[key] = orig;
    });
}

/** @param {any} t @param {(base: string) => Promise<void>} fn */
async function withServer(t, fn) {
    const app = express();
    app.use('/share', viewer);
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    t.after(() => server.close());
    return fn(`http://127.0.0.1:${server.address().port}`);
}

/** @param {Record<string, string | undefined>} vars @param {() => Promise<void>} fn */
async function withEnv(vars, fn) {
    const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { await fn(); } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
}

const TOKEN = 'b'.repeat(40);
const SHARE = {
    id: 'sh1', webpageId: 'wp1', createdBy: 'u1', accessMode: 'unlisted',
    title: 'Page', snapshotKind: 'static', organizationId: null,
};

/** @param {Record<string, any>} [shareOver] @param {any[]} [extra] */
function stubs(shareOver = {}, extra = []) {
    return [
        [publicShareStore, 'findByToken', async (/** @type {string} */ t) => (t === TOKEN ? { ...SHARE, ...shareOver } : null)],
        [publicShareStore, 'recordView', async () => {}],
        [userStore, 'getUser', async () => ({ name: 'Owner' })],
        [webpageStore, 'getBridgeGrants', async () => null],
        [webpageSnapshot, 'readSnapshotSlot', async (/** @type {string} */ _id, /** @type {string} */ slot) => (
            slot === 'reactdoc' ? '<html><head></head><body><script>1</script></body></html>'
                : slot === 'html' ? '<p>hi</p>' : 'p{}')],
        ...extra,
    ];
}

/** @param {string | null} csp */
function assertOpaqueSandbox(csp) {
    assert.ok(csp, 'a CSP header is sent');
    const sandbox = csp.split(';').map(s => s.trim()).find(s => s.startsWith('sandbox'));
    assert.ok(sandbox, `CSP carries a sandbox directive: ${csp}`);
    assert.ok(!/allow-same-origin/.test(sandbox), 'the sandbox never grants allow-same-origin');
}

test('static /content carries a CSP sandbox without allow-same-origin', async (t) => {
    await withPatches(stubs(), () => withServer(t, async (b) => {
        const res = await fetch(`${b}/share/${TOKEN}/content`);
        assert.strictEqual(res.status, 200);
        assertOpaqueSandbox(res.headers.get('content-security-policy'));
    }));
});

test('react /content carries a CSP sandbox without allow-same-origin', async (t) => {
    await withPatches(stubs({ snapshotKind: 'react' }), () => withServer(t, async (b) => {
        const res = await fetch(`${b}/share/${TOKEN}/content`);
        assert.strictEqual(res.status, 200);
        const csp = res.headers.get('content-security-policy');
        assertOpaqueSandbox(csp);
        assert.match(String(csp), /sandbox allow-scripts allow-forms/, 'the React app still runs, in the opaque origin');
    }));
});

test('the viewer page still embeds the content in its sandboxed iframe', async (t) => {
    await withPatches(stubs(), () => withServer(t, async (b) => {
        const res = await fetch(`${b}/share/${TOKEN}`);
        assert.strictEqual(res.status, 200);
        const html = await res.text();
        assert.match(html, new RegExp(`<iframe[^>]*sandbox="allow-scripts allow-forms"[^>]*src="/share/${TOKEN}/content`));
    }));
});

for (const [file, type, attachment] of /** @type {const} */ ([
    ['data.xml', 'application/xml; charset=utf-8', true],
    ['page.xhtml', 'application/xhtml+xml', true],
    ['notes.json', 'application/json; charset=utf-8', true],
    ['blob.bin', 'application/octet-stream', true],
    ['logo.png', 'image/png', false],
    ['site.css', 'text/css; charset=utf-8', false],
    ['about.html', 'text/html; charset=utf-8', false],
    ['icon.svg', 'image/svg+xml; charset=utf-8', false],
])) {
    test(`/extras/${file}: sandbox CSP, ${attachment ? 'download' : 'inline'}`, async (t) => {
        await withPatches(stubs({}, [
            [webpageSnapshot, 'readSnapshotExtra', async () => ({ bytes: Buffer.from('x'), contentType: type })],
        ]), () => withServer(t, async (b) => {
            const res = await fetch(`${b}/share/${TOKEN}/extras/${file}`);
            assert.strictEqual(res.status, 200);
            const csp = res.headers.get('content-security-policy');
            assertOpaqueSandbox(csp);
            assert.match(String(csp), /script-src 'none'/);
            const disp = res.headers.get('content-disposition');
            if (attachment) assert.match(String(disp), /^attachment/);
            else assert.strictEqual(disp, null);
        }));
    });
}

/** @param {string} b @param {string} host */
function postUnlock(b, host) {
    return fetch(`${b}/share/${TOKEN}/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Host: host },
        body: 'email=reader%40example.org&_csrf=x',
    });
}

const EMAIL_SHARE = stubs({ accessMode: 'email' }, [
    [publicShareToken, 'verifyCsrf', () => true],
    [publicShareStore, 'isEmailAllowed', () => true],
]);

test('magic link uses the configured base, not the Host header', async (t) => {
    sentMails.length = 0;
    await withEnv({
        PUBLIC_SHARE_BASE_URL: undefined, PUBLIC_APP_URL: undefined, PUBLIC_BASE_URL: undefined,
        CLIENT_PROTOCOL: 'https', CLIENT_PUBLIC_HOST: 'share.example.test',
    },
        () => withPatches(EMAIL_SHARE, () => withServer(t, async (b) => {
            const res = await postUnlock(b, 'other.example.net');
            assert.strictEqual(res.status, 200);
            assert.strictEqual(sentMails.length, 1);
            assert.match(sentMails[0].text, /https:\/\/share\.example\.test\/share\//);
            assert.ok(!sentMails[0].text.includes('other.example.net'));
            assert.ok(!sentMails[0].html.includes('other.example.net'));
        })));
});

test('in production without a configured base no magic link is sent', async (t) => {
    sentMails.length = 0;
    await withEnv({
        NODE_ENV: 'production', PUBLIC_SHARE_BASE_URL: undefined, PUBLIC_APP_URL: undefined,
        PUBLIC_BASE_URL: undefined, CLIENT_PUBLIC_HOST: undefined,
    }, () => withPatches(EMAIL_SHARE, () => withServer(t, async (b) => {
        const res = await postUnlock(b, 'other.example.net');
        assert.strictEqual(res.status, 200, 'the visitor sees the same page');
        assert.strictEqual(sentMails.length, 0);
    })));
});
