'use strict';
// Smoke test per shipped component: the way the server runs one
// (`node index.js` in the component's folder, inputs as JSON on stdin, one
// JSON object on stdout), against a local stand-in for whatever it talks to.
// No test leaves this machine. Run: node --test components/smoke.test.js
// (after `npm ci` in each component folder that has a package-lock.json).
//
// One file at components/ rather than one per folder: a component's folder
// holds only what the server runs (the Component Designer, removed 2026-10,
// listed every .js file there as part of the component). Each case below is
// still one component, and the last test fails when a component has no case.
//
// Where a component can only reach a fixed public host (tavily-search) or
// refuses every internal address (the two safeGet components), the case drives
// the path that runs without network: the input check or the SSRF refusal.
// That still proves the entry point loads with its installed dependencies and
// speaks the stdin/stdout protocol.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const ROOT = __dirname;
const TIMEOUT_MS = 20_000;

// A proxy from the developer's shell would send the loopback requests below
// somewhere else (axios honours these variables).
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
function childEnv() {
    const env = { ...process.env, NO_PROXY: '*', no_proxy: '*' };
    for (const name of PROXY_VARS) delete env[name];
    return env;
}

/** Run a component as the server does; resolves { code, stdout, stderr, json }. */
function runComponent(name, inputs) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['index.js'], {
            cwd: path.join(ROOT, name),
            env: childEnv(),
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`${name} did not exit within ${TIMEOUT_MS} ms; stderr: ${stderr}`));
        }, TIMEOUT_MS);
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('close', (code) => {
            clearTimeout(timer);
            let json;
            try { json = stdout.trim() ? JSON.parse(stdout) : undefined; } catch { json = undefined; }
            resolve({ code, stdout, stderr, json });
        });
        child.stdin.end(JSON.stringify(inputs));
    });
}

/** A loopback HTTP server; `handler(req, body)` returns [status, jsonBody]. */
async function withHttpServer(handler, fn) {
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, headers: req.headers, body });
            const [status, payload] = handler(req, body);
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(payload));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        return await fn(`http://127.0.0.1:${server.address().port}`, seen);
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}

/** A minimal SMTP server: no TLS, AUTH PLAIN, accepts one message. */
async function withSmtpServer(fn) {
    const received = { from: null, to: [], data: '' };
    const server = net.createServer((socket) => {
        let buffer = '';
        let inData = false;
        socket.write('220 localhost smoke ESMTP\r\n');
        socket.on('data', (chunk) => {
            buffer += chunk;
            let i;
            while ((i = buffer.indexOf('\r\n')) !== -1) {
                const line = buffer.slice(0, i);
                buffer = buffer.slice(i + 2);
                if (inData) {
                    if (line === '.') {
                        inData = false;
                        socket.write('250 2.0.0 Ok: queued as SMOKE1\r\n');
                    } else {
                        received.data += `${line}\n`;
                    }
                    continue;
                }
                const verb = line.slice(0, 4).toUpperCase();
                if (verb === 'EHLO') socket.write('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
                else if (verb === 'HELO') socket.write('250 localhost\r\n');
                else if (verb === 'AUTH') socket.write('235 2.7.0 Authentication successful\r\n');
                else if (verb === 'MAIL') { received.from = line; socket.write('250 2.1.0 Ok\r\n'); }
                else if (verb === 'RCPT') { received.to.push(line); socket.write('250 2.1.5 Ok\r\n'); }
                else if (verb === 'DATA') { inData = true; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
                else if (verb === 'QUIT') { socket.end('221 2.0.0 Bye\r\n'); }
                else socket.write('250 Ok\r\n');
            }
        });
        socket.on('error', () => {});
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        return await fn(server.address().port, received);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

const CASES = {
    'afas-customer-data': async () => {
        await withHttpServer((req) => {
            if (req.url === '/oauth/token') return [200, { access_token: 'smoke-token' }];
            if (req.url.startsWith('/api/v1/customers')) return [200, [{ id: 'C1' }]];
            if (req.url.startsWith('/api/v1/attachments')) return [200, [{ id: 'A1' }]];
            return [404, {}];
        }, async (base, seen) => {
            const r = await runComponent('afas-customer-data', {
                afasBaseUrl: base, clientId: 'id', clientSecret: 'not-a-secret', customerId: 'C1', includeAttachments: true,
            });
            assert.equal(r.code, 0, r.stderr);
            assert.deepEqual(r.json, { success: true, customers: [{ id: 'C1' }], attachments: [{ id: 'A1' }] });
            const customers = seen.find((s) => s.url.startsWith('/api/v1/customers'));
            assert.equal(customers.headers.authorization, 'Bearer smoke-token');
        });
        const missing = await runComponent('afas-customer-data', {});
        assert.equal(missing.code, 1);
        assert.deepEqual(missing.json, { success: false, error: "'afasBaseUrl' is required" });
    },

    'email-sender-smtp': async () => {
        await withSmtpServer(async (port, received) => {
            const r = await runComponent('email-sender-smtp', {
                smtpHost: '127.0.0.1', smtpPort: port, smtpUsername: 'user', smtpPassword: 'not-a-secret',
                useTLS: false, fromEmail: 'from@example.com', toEmails: 'to@example.com',
                subject: 'Smoke', body: 'Hello from the smoke test',
            });
            assert.equal(r.code, 0, r.stderr);
            assert.equal(r.json.success, true);
            assert.equal(r.json.acceptedRecipients, 'to@example.com');
            assert.equal(r.json.rejectedRecipients, '');
            assert.equal(r.json.error, null);
            assert.equal(typeof r.json.messageId, 'string');
            assert.match(received.to[0], /to@example\.com/);
            assert.match(received.data, /Hello from the smoke test/);
        });
    },

    'get-date-time': async () => {
        const r = await runComponent('get-date-time', { baseDate: '2024-02-10', period: 'month', format: 'yyyy-MM-dd' });
        assert.equal(r.code, 0, r.stderr);
        assert.deepEqual(r.json, { datetime: '2024-02-29' });
        const added = await runComponent('get-date-time', { baseDate: '2024-02-10', amount: 3, unit: 'days', format: 'yyyy-MM-dd' });
        assert.deepEqual(added.json, { datetime: '2024-02-13' });
        const bad = await runComponent('get-date-time', { period: 'decade' });
        assert.equal(bad.code, 1);
        assert.match(bad.json.error, /'period' must be one of/);
    },

    'n8n-webhook-header-auth': async () => {
        await withHttpServer((req, body) => [200, { echoed: JSON.parse(body) }], async (base, seen) => {
            const r = await runComponent('n8n-webhook-header-auth', {
                webhookUrl: `${base}/webhook/smoke`, headerName: 'X-Smoke', headerValue: 'not-a-secret', data: [{ a: 1 }],
            });
            assert.equal(r.code, 0, r.stderr);
            assert.deepEqual(r.json, { response: { echoed: [{ a: 1 }] }, status: 200, success: true });
            assert.equal(seen[0].method, 'POST');
            assert.equal(seen[0].headers['x-smoke'], 'not-a-secret');
        });
    },

    'random-number': async () => {
        const r = await runComponent('random-number', { min: 5, max: 7 });
        assert.equal(r.code, 0, r.stderr);
        assert.equal(r.json.min, 5);
        assert.equal(r.json.max, 7);
        assert.ok(Number.isInteger(r.json.result) && r.json.result >= 5 && r.json.result <= 7, `result ${r.json.result}`);
        const bad = await runComponent('random-number', { min: 9, max: 3 });
        assert.equal(bad.code, 0);
        assert.deepEqual(bad.json, { result: null, min: 9, max: 3, error: 'min must be less than max' });
    },

    // Talks only to api.tavily.com, so the smoke stays on the input check.
    'tavily-search': async () => {
        const r = await runComponent('tavily-search', { apiKey: 'not-a-key' });
        assert.equal(r.code, 1);
        assert.equal(r.stdout, '');
        assert.match(r.stderr, /Search query is required/);
    },

    // safeGet refuses every internal address, a loopback stand-in included.
    'webpage-to-markdown': async () => {
        const r = await runComponent('webpage-to-markdown', { url: 'http://127.0.0.1:9/' });
        assert.equal(r.code, 1);
        assert.equal(r.json.success, false);
        assert.match(r.json.error, /^Refused: target resolves to a private\/internal address/);
        const missing = await runComponent('webpage-to-markdown', {});
        assert.equal(missing.code, 1);
        assert.equal(missing.json.error, "'url' input is required");
    },

    'website-sitemap-fetcher': async () => {
        const r = await runComponent('website-sitemap-fetcher', { url: 'http://127.0.0.1:9/' });
        assert.equal(r.code, 0, r.stderr);
        assert.equal(r.json.success, true);
        assert.deepEqual(r.json.pageUrls, []);
        assert.match(r.json.warnings[0].message, /robots\.txt.*Refused/);
        const missing = await runComponent('website-sitemap-fetcher', {});
        assert.equal(missing.code, 1);
        assert.equal(missing.json.success, false);
        assert.equal(missing.json.error, "'url' is required");
    },

    'youtrack-read-items': async () => {
        await withHttpServer(() => [200, [{ id: '1-1', summary: 'Smoke' }]], async (base, seen) => {
            const r = await runComponent('youtrack-read-items', {
                youtrackUrl: base, apiToken: 'not-a-token', query: 'project: X', fields: 'id,summary', max: 5,
            });
            assert.equal(r.code, 0, r.stderr);
            assert.deepEqual(r.json, { items: [{ id: '1-1', summary: 'Smoke' }], success: true });
            assert.equal(seen[0].url, '/api/issues?query=project%3A%20X&fields=id%2Csummary&max=5');
            assert.equal(seen[0].headers.authorization, 'Bearer not-a-token');
        });
    },
};

for (const [name, run] of Object.entries(CASES)) {
    test(`${name}: stdin JSON in, JSON out`, run);
}

test('every shipped component has a smoke case', () => {
    const shipped = fs.readdirSync(ROOT, { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(ROOT, e.name, 'component.json')))
        .map((e) => e.name)
        .sort();
    assert.deepEqual(Object.keys(CASES).sort(), shipped,
        'a component folder without a case here (or a case without its folder): add one to CASES');
});
