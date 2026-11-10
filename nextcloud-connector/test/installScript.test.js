// The install script the setup page offers (src/installScript.js): the answers
// of an administrator become assignments at the top of a fixed shell script,
// and nothing else in the script depends on them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installValues, NO_SERVER } = require('./support/installValues');

installValues(NO_SERVER);
const { validateInstallOptions, buildInstallScript, addressesFor, shellWord, SCRIPT_FILENAME } = require('../src/installScript');
const { postAsAdmin } = require('./support/setupRequests');

const GOOD = { host: '192.168.1.20', organisation: 'Acme BV' };

/** @param {Record<string, unknown>} answers */
function scriptFor(answers) {
    const checked = validateInstallOptions(answers);
    assert.equal(checked.ok, true, JSON.stringify(checked));
    return buildInstallScript(checked.options);
}

/** The assignments block and everything under it. */
function parts(script) {
    const at = script.indexOf("\nREPOSITORY='");
    assert.ok(at > 0);
    return { head: script.slice(0, at), body: script.slice(at) };
}

test('the defaults: both ports, the newest release, guard and classifier, a private Nextcloud', () => {
    const checked = validateInstallOptions(GOOD);
    assert.deepEqual(checked.options, {
        host: '192.168.1.20', serverPort: 3001, clientPort: 5176, dir: 'beeflow', version: 'latest',
        sidecars: true, privateNextcloud: true, organisation: 'Acme BV', stackName: '',
    });
    const { head } = parts(scriptFor(GOOD));
    assert.match(head, /^HOST='192\.168\.1\.20'/m);
    assert.match(head, /^SERVER_PORT='3001'$/m);
    assert.match(head, /^CLIENT_PORT='5176'$/m);
    assert.match(head, /^VERSION='latest'/m);
    assert.match(head, /^PROFILES='core guard classify'$/m);
    assert.match(head, /^PRIVATE_NEXTCLOUD='1'/m);
    assert.match(head, /^ORGANISATION='Acme BV'/m);
    assert.deepEqual(addressesFor(checked.options), { serverUrl: 'http://192.168.1.20:3001', webAppUrl: 'http://192.168.1.20:5176' });
});

test('the choices an administrator can make', () => {
    const { head } = parts(scriptFor({
        host: 'BeeFlow.Example.com', serverPort: '8443', clientPort: 8080, dir: '/opt/beeflow', version: 'v2026.11.10.3',
        sidecars: false, privateNextcloud: false, organisation: '', stackName: 'internal',
    }));
    assert.match(head, /^INSTALL_DIR='\/opt\/beeflow'$/m);
    assert.match(head, /^HOST='beeflow\.example\.com'/m, 'a host name is lower case');
    assert.match(head, /^SERVER_PORT='8443'$/m);
    assert.match(head, /^CLIENT_PORT='8080'$/m);
    assert.match(head, /^VERSION='v2026\.11\.10\.3'/m);
    assert.match(head, /^PROFILES='core'$/m);
    assert.match(head, /^PRIVATE_NEXTCLOUD='0'/m);
    assert.match(head, /^ORGANISATION=''/m);
    assert.match(head, /^STACK_NAME='internal'/m);
});

test('everything under the choices is the same text, whatever the answers', () => {
    const a = parts(scriptFor(GOOD)).body;
    const b = parts(scriptFor({ host: 'srv.example.org', serverPort: 9001, clientPort: 9002, dir: '~/bf', version: 'v1.2.3', sidecars: false, organisation: 'Other', stackName: 'x1' })).body;
    assert.equal(a, b);
});

test('the script is valid shell', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-install-'));
    try {
        const file = path.join(dir, SCRIPT_FILENAME);
        fs.writeFileSync(file, scriptFor(GOOD));
        const checked = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
        assert.equal(checked.status, 0, checked.stderr);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the secrets are made by the installer on the host, not here', () => {
    const script = scriptFor(GOOD);
    assert.ok(script.includes('./selfhost.sh'), 'the release installer does the work');
    for (const word of ['openssl', 'urandom', 'SESSION_SECRET=', 'MASTER_ENCRYPTION_KEY=']) {
        assert.ok(!script.includes(word), `${word} is not part of the script`);
    }
    assert.ok(script.includes('raw.githubusercontent.com/$REPOSITORY/$TAG/'), 'files come from the release tag');
});

test('an answer that is not a plain value is refused, field by field', () => {
    const refused = (answers, field) => {
        const checked = validateInstallOptions({ ...GOOD, ...answers });
        assert.equal(checked.ok, false, JSON.stringify(answers));
        assert.ok(checked.errors[field], `${field}: ${JSON.stringify(checked.errors)}`);
    };
    for (const host of ['', 'a;rm -rf /', '$(id)', '`id`', 'a b', "a'b", 'http://x', 'x:3001', '-x.example', 'x..y', 'localhost', '127.0.0.1', '::1']) refused({ host }, 'host');
    for (const serverPort of ['0', '65536', '30 01', '3001;id', '-1', 'abc']) refused({ serverPort }, 'serverPort');
    refused({ serverPort: 5000, clientPort: 5000 }, 'clientPort');
    for (const dir of ['../x', 'a/../b', '$(id)', 'a b', "a'b", 'a;b', 'x~y']) refused({ dir }, 'dir');
    for (const version of ['main', 'v1;id', 'v$(id)', '1.2.3']) refused({ version }, 'version');
    for (const organisation of ["Acme'; id", 'a$b', 'a`b`', 'x'.repeat(81)]) refused({ organisation }, 'organisation');
    for (const stackName of ['Internal', '-x', 'a b', 'beeflow', 'a;b']) refused({ stackName }, 'stackName');
});

test('a value becomes one single-quoted shell word', () => {
    assert.equal(shellWord('plain'), "'plain'");
    assert.equal(shellWord("it's"), "'it'\\''s'");
    assert.equal(shellWord(3001), "'3001'");
});

test('POST setup/install-script answers the script to an administrator', async () => {
    const setupRouter = require('../src/setup');
    const ok = await postAsAdmin(setupRouter, '/setup/install-script', { host: 'beeflow.example.com', serverPort: 3101 });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.filename, SCRIPT_FILENAME);
    assert.equal(ok.body.serverUrl, 'http://beeflow.example.com:3101');
    assert.equal(ok.body.webAppUrl, 'http://beeflow.example.com:5176');
    assert.match(ok.body.script, /^HOST='beeflow\.example\.com'/m);

    const bad = await postAsAdmin(setupRouter, '/setup/install-script', { host: '$(id)' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'invalid_install_options');
    assert.ok(bad.body.fields.host);
    assert.equal(bad.body.script, undefined);
});
