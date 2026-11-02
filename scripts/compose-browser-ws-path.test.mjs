import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The browser sidecar has no authentication of its own: its WebSocket path is
// the only secret. A compose file that falls back to a fixed path when
// BROWSER_WS_PATH is unset would serve every such install at the same path, so
// every reference must use the required form `${BROWSER_WS_PATH:?...}`.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const composeFiles = readdirSync(root).filter(f => /^docker-compose.*\.yml$/.test(f));

const references = composeFiles.flatMap(file => readFileSync(join(root, file), 'utf8').split('\n')
    .map((text, i) => ({ file, line: i + 1, text }))
    .filter(({ text }) => /\$\{BROWSER_WS_PATH\b/.test(text) && !/^\s*#/.test(text)));

test('the compose files reference BROWSER_WS_PATH', () => {
    assert.ok(references.length >= 4, `expected the server and browser services of both stacks, got ${references.length}`);
});

test('BROWSER_WS_PATH has no default in any compose file', () => {
    const withDefault = references.filter(({ text }) => !/\$\{BROWSER_WS_PATH:\?[^}]+\}/.test(text));
    assert.deepEqual(withDefault.map(({ file, line }) => `${file}:${line}`), []);
});

test('the e2e stack env and selfhost.sh both supply BROWSER_WS_PATH', () => {
    const writeEnvLines = readFileSync(join(root, 'e2e/ci/write-env.sh'), 'utf8').split('\n');
    assert.ok(writeEnvLines.some(l => /^BROWSER_WS_PATH=\$\(openssl rand -hex \d+\)$/.test(l)));
    const selfhostLines = readFileSync(join(root, 'selfhost.sh'), 'utf8').split('\n');
    assert.ok(selfhostLines.some(l => /set_env BROWSER_WS_PATH "\$\(gen_hex \d+\)"/.test(l)));
});
