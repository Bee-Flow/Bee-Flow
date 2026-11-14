'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { execFile } = require('node:child_process');

const GUARD = require.resolve('./componentNetGuard');
let server; let port;
before(async () => {
    server = http.createServer((_req, res) => res.end('INTERNAL'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
});
after(() => new Promise((resolve) => server.close(resolve)));

/** Runs `script` the way a component runs: a bare node process with the guard preloaded. */
function runGuarded(script, allowedHosts = '') {
    // Not spawnSync: the server above lives in this process and has to answer.
    return new Promise((resolve) => {
        execFile('node', ['--require', GUARD, '-e', script], {
            encoding: 'utf8', timeout: 20000,
            env: { PATH: process.env.PATH, BEEFLOW_COMPONENT_ALLOWED_HOSTS: allowedHosts },
        }, (_err, stdout, stderr) => resolve((stdout || '').trim() || `stderr: ${stderr}`));
    });
}
const GET = (url) => `require('http').get(${JSON.stringify(url)}, r => { let b=''; r.on('data', d => b += d); r.on('end', () => console.log('OK ' + b)); }).on('error', e => console.log('ERR ' + e.code));`;

test('a literal loopback address is refused inside the component process', async () => {
    assert.strictEqual(await runGuarded(GET(`http://127.0.0.1:${port}/`)), 'ERR EPRIVATEADDRESS');
});

test('a name that resolves to a private address is refused at the connection, not only before the run', async () => {
    assert.strictEqual(await runGuarded(GET(`http://localhost:${port}/`)), 'ERR EPRIVATEADDRESS');
});

test('a raw socket (what an SMTP client opens) is screened the same way', async () => {
    const script = `require('net').connect(${port}, '127.0.0.1').on('connect', () => console.log('OK')).on('error', e => console.log('ERR ' + e.code));`;
    assert.strictEqual(await runGuarded(script), 'ERR EPRIVATEADDRESS');
});

test('a host the operator allowed, and the allow-all switch, connect', async () => {
    assert.strictEqual(await runGuarded(GET(`http://127.0.0.1:${port}/`), '127.0.0.1'), 'OK INTERNAL');
    assert.strictEqual(await runGuarded(GET(`http://127.0.0.1:${port}/`), '*'), 'OK INTERNAL');
});
