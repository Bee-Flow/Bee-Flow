/**
 * runtime-watch is a gate input, so the tests that matter are the ones where
 * it must SAY something: a newer Node security release, an EOL cycle, an
 * image it cannot judge, a feed it could not read. Feeds are injected; no
 * network.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discover, judge, parseImageRef, versionOf, run } from './runtime-watch.mjs';

const TODAY = '2026-10-23';
const NODE_INDEX = [
    { version: 'v22.23.4', date: '2026-10-20', security: true },
    { version: 'v22.23.3', date: '2026-09-23', security: false },
    { version: 'v22.23.2', date: '2026-07-28', security: true },
    { version: 'v24.22.1', date: '2026-10-21', security: true },
];
const EOL = {
    nodejs: [{ cycle: '22', eol: '2027-04-30', latest: '22.23.4' }, { cycle: '18', eol: '2025-04-30', latest: '18.20.8' }],
    python: [{ cycle: '3.12', eol: '2028-10-31', latest: '3.12.12' }, { cycle: '3.8', eol: '2024-10-07', latest: '3.8.20' }],
    redis: [{ cycle: '7.4', eol: false, latest: '7.4.11' }],
    postgresql: [{ cycle: '15', eol: '2027-11-11', latest: '15.14' }],
};
const FEEDS = { nodeIndex: NODE_INDEX, eol: EOL };
const pin = (over) => ({ file: 'x/Dockerfile', line: 3, ref: 'ref', ...over });

test('a pin behind a Node security release in its own line is high', () => {
    const [f] = judge(pin({ key: 'node', version: '22.23.2' }), FEEDS, TODAY);
    assert.equal(f.level, 'high');
    assert.match(f.message, /v22\.23\.4/);
});

test('a pin on the latest Node security release is quiet, a newer major line does not count', () => {
    assert.deepEqual(judge(pin({ key: 'node', version: '22.23.4' }), FEEDS, TODAY), []);
});

test('a cycle past end of life is high', () => {
    assert.equal(judge(pin({ key: 'python', version: '3.8' }), FEEDS, TODAY)[0].level, 'high');
    assert.equal(judge(pin({ key: 'node', version: '18.20.8' }), FEEDS, TODAY)[0].level, 'high');
});

test('behind on a patch without a security flag is a notice, not high', () => {
    const [f] = judge(pin({ key: 'python', version: '3.12.3' }), FEEDS, TODAY);
    assert.equal(f.level, 'notice');
});

test('an unreadable feed is an error, never silence', () => {
    assert.equal(judge(pin({ key: 'redis', version: '7.4.1' }), { nodeIndex: NODE_INDEX, eol: {} }, TODAY)[0].level, 'error');
    const out = judge(pin({ key: 'node', version: '22.23.2' }), { nodeIndex: undefined, eol: EOL }, TODAY);
    assert.ok(out.some((f) => f.level === 'error'));
});

test('an image with no feed is named as unchecked', () => {
    const [f] = judge(pin({ key: 'ollama/ollama', version: '0.40.1' }), FEEDS, TODAY);
    assert.equal(f.level, 'unchecked');
});

test('image references: compose defaults, digests, registries, own images', () => {
    assert.deepEqual(parseImageRef('node:22.23.4-alpine@sha256:abc'), { image: 'node', key: 'node', tag: '22.23.4-alpine' });
    assert.equal(parseImageRef('docker.io/library/python:3.12-slim').key, 'python');
    assert.equal(parseImageRef('pgvector/pgvector:pg15').key, 'pgvector/pgvector');
    assert.equal(parseImageRef('${REGISTRY:-ghcr.io/bee-flow}/server:${TAG:-latest}'), null);
    assert.equal(parseImageRef('${X:-redis:7.4.11-alpine}').tag, '7.4.11-alpine');
    assert.equal(parseImageRef('src', new Set(['src'])), null);
    assert.equal(versionOf('pg15'), '15');
    assert.equal(versionOf('alpine'), null);
});

test('discovery reads version files, every FROM and every compose image, skipping stages', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-watch-'));
    fs.writeFileSync(path.join(dir, '.nvmrc'), '22.23.2\n');
    fs.mkdirSync(path.join(dir, 'svc'));
    fs.writeFileSync(path.join(dir, 'svc/Dockerfile'), 'FROM node:22.23.2-slim AS deps\nFROM deps AS build\nFROM python:3.8-slim\n');
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services:\n  r:\n    image: redis:7.4.11-alpine\n  o:\n    image: ollama/ollama:0.40.1\n');
    const files = ['.nvmrc', 'svc/Dockerfile', 'docker-compose.yml'];
    const pins = discover(dir, files);
    assert.deepEqual(pins.map((p) => `${p.file}:${p.line} ${p.key}@${p.version}`), [
        '.nvmrc:1 node@22.23.2',
        'svc/Dockerfile:1 node@22.23.2',
        'svc/Dockerfile:3 python@3.8',
        'docker-compose.yml:3 redis@7.4.11',
        'docker-compose.yml:5 ollama/ollama@0.40.1',
    ]);

    const fetchImpl = async (url) => {
        const product = /endoflife\.date\/api\/(.+)\.json/.exec(url)?.[1];
        const body = product ? EOL[product] : NODE_INDEX;
        return { ok: Boolean(body), json: async () => body };
    };
    const { findings } = await run({ root: dir, files, fetchImpl, today: TODAY });
    const highs = findings.filter((f) => f.level === 'high').map((f) => `${f.file}:${f.line}`);
    assert.deepEqual(highs, ['.nvmrc:1', 'svc/Dockerfile:1', 'svc/Dockerfile:3']);
    assert.ok(findings.some((f) => f.level === 'unchecked' && f.ref.startsWith('ollama/')));
});
