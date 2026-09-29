/**
 * An MCP child process gets what it needs to run, and nothing about Bee Flow.
 *
 * Both spawn sites used `{ ...process.env, ...userEnv }`, which handed a
 * third-party program every secret the server holds. The program in question is
 * frequently `npx <package>` — downloaded and executed at the moment of the
 * call — so the thing receiving the database password was code fetched from the
 * internet during the request.
 *
 * The tests below check the property that has to survive a rewrite: a name
 * nobody put on the list does not reach the child. The last one is the point of
 * the whole file — it asserts against secrets that do not appear anywhere in
 * mcpChildEnv.js, so a future deny-list rewrite that "handles the known ones"
 * still fails here.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { ALLOWED_ENV, buildMcpChildEnv } = require('./mcpChildEnv');

test('passes through the variables a child needs in order to start', () => {
    const source = { PATH: '/usr/bin', HOME: '/home/app', LANG: 'en_US.UTF-8', TMPDIR: '/tmp' };
    const env = buildMcpChildEnv({}, source);
    assert.strictEqual(env.PATH, '/usr/bin');
    assert.strictEqual(env.HOME, '/home/app');
    assert.strictEqual(env.LANG, 'en_US.UTF-8');
    assert.strictEqual(env.TMPDIR, '/tmp');
});

test('drops everything that is not on the list', () => {
    // Named secrets, but the assertion that matters is the count: the output
    // may only contain keys the list allows.
    const source = {
        PATH: '/usr/bin',
        DATABASE_URL: 'postgres://beeflow:hunter2@db/beeflow',
        MASTER_ENCRYPTION_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        OPAQUE_SERVER_SETUP: 'opaque-setup-blob',
        SESSION_SECRET: 'session-secret',
        ANTHROPIC_API_KEY: 'sk-ant-xxx',
        SOME_FUTURE_SECRET: 'not-invented-yet',
    };
    const env = buildMcpChildEnv({}, source);
    assert.deepStrictEqual(Object.keys(env), ['PATH']);
    for (const leaked of Object.keys(source).filter((k) => k !== 'PATH')) {
        assert.ok(!(leaked in env), `${leaked} reached the child`);
    }
});

test('a variable invented tomorrow is excluded without anyone updating this file', () => {
    // The reason it is an allow-list. A deny-list of "sensitive" names loses
    // the moment somebody adds SMTP_PASSWORD to the server's environment: not
    // on the list, so it leaks, and nothing fails.
    const source = { PATH: '/usr/bin', SMTP_PASSWORD: 'p', STRIPE_SECRET: 's', NEW_THING_2027: 'x' };
    const env = buildMcpChildEnv({}, source);
    assert.deepStrictEqual(Object.keys(env), ['PATH']);
});

test('the configured per-server credentials still reach the child, and win', () => {
    // The channel an operator set up on purpose. Without this the fix would
    // break every MCP server that needs a key.
    const env = buildMcpChildEnv({ GITHUB_TOKEN: 'ghp_x', PATH: '/opt/custom/bin' }, { PATH: '/usr/bin' });
    assert.strictEqual(env.GITHUB_TOKEN, 'ghp_x');
    assert.strictEqual(env.PATH, '/opt/custom/bin', 'an explicit per-server value must override the inherited one');
});

test('NODE_OPTIONS is not inheritable', () => {
    // It can inject `--require <module>` into the child, which is code
    // execution wearing an environment variable's clothes.
    assert.ok(!ALLOWED_ENV.includes('NODE_OPTIONS'));
    const env = buildMcpChildEnv({}, { NODE_OPTIONS: '--require /tmp/evil.js', PATH: '/usr/bin' });
    assert.ok(!('NODE_OPTIONS' in env));
});

test('an empty string survives but an unset variable does not appear', () => {
    // `NO_PROXY=` is a real setting and is not the same as unset; an undefined
    // key would otherwise arrive as the string "undefined".
    const env = buildMcpChildEnv({}, { PATH: '/usr/bin', NO_PROXY: '', TERM: undefined });
    assert.strictEqual(env.NO_PROXY, '');
    assert.ok(!('TERM' in env));
});

test('the result never aliases the parent environment', () => {
    const source = { PATH: '/usr/bin' };
    const env = buildMcpChildEnv({}, source);
    env.PATH = '/changed';
    assert.strictEqual(source.PATH, '/usr/bin', 'mutating the child env reached back into the parent');
});

test('neither spawn site spreads the whole environment any more', () => {
    // Genuinely textual: the property that regressed. Checked against the
    // source because the spawn happens inside an SDK transport constructor
    // that a unit test cannot reach without standing up a real MCP server.
    const src = fs.readFileSync(path.join(__dirname, 'mcpManager.js'), 'utf8');
    assert.ok(
        !/env:\s*\{\s*\.\.\.process\.env/.test(src),
        'mcpManager still hands a child `{ ...process.env, ... }` — that is the whole finding',
    );
    const uses = src.match(/env:\s*buildMcpChildEnv\(/g) || [];
    assert.strictEqual(
        uses.length,
        2,
        'expected both spawn sites (the runtime one and the /test one) to build their env through '
        + 'the allow-list; the test path spawns exactly the same third-party command and must not '
        + 'be the looser of the two',
    );
});
