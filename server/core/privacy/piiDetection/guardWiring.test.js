/**
 * The wiring between "what the deployment sets" and "what the server reads".
 *
 * This file exists because those two drifted apart and nobody noticed. Both
 * compose files set GUARD_SERVICE_URL, which reads like the guard is wired;
 * the resolver in guardEndpoint.js only ever looked at PII_SERVICE_URL. Net
 * effect on a fresh self-host: the guard container runs, its healthcheck is
 * green, and detectPii() returns null on every call — PII detection off, every
 * caller falling open, nothing in the logs but one line per scan.
 *
 * A unit test cannot catch that: every module was correct on its own. So the
 * assertions below are about the SEAM. They read the real deployment files and
 * the real resolver, and they fail on the CLASS rather than on the one name
 * that was wrong:
 *
 *   1. every guard-ish variable a compose file sets is one the server reads
 *      somewhere (a name nothing consumes is the defect that started this);
 *   2. PII_SERVICE_URL is present in both compose files;
 *   3. its default is EMPTY, and that is not an oversight — see below;
 *   4. selfhost.sh fills it in, and only under the guard profile.
 *
 * ── WHY AN EMPTY DEFAULT IS THE CORRECT ONE ─────────────────────────
 * "Not configured" and "configured but unreachable" are different paths.
 * detectPii() returns null for the first (callers fall open, feature absent)
 * and a `degraded` result for the second, which then applies the org's
 * piiFailureMode — default fail_closed, i.e. the message is blocked. A
 * non-empty default in the compose file would point a core-only stack at a
 * host that only exists under `--profile guard`, converting an absent feature
 * into a blocked chat. So the value belongs where the profile is known:
 * selfhost.sh.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../../../..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const COMPOSE_FILES = ['docker-compose.from-registry.yml', 'docker-compose.yml'];

/** Every `process.env.NAME` the server reads, anywhere under server/. */
function envNamesReadByServer() {
    // git grep, not a recursive fs walk: node_modules is enormous and the
    // answer only concerns tracked source.
    const out = execFileSync(
        'git',
        ['grep', '-hoE', 'process\\.env\\.[A-Z0-9_]+', '--', 'server/'],
        { cwd: REPO, encoding: 'utf8', maxBuffer: 1e8 },
    );
    return new Set(out.split('\n').filter(Boolean).map((l) => l.replace('process.env.', '')));
}

/**
 * The `environment:` block of one service in a compose file.
 *
 * Scoped to a single service on purpose. The guard-service block legitimately
 * carries GUARD_PII_MODEL, GUARD_PII_USE_ONNX and friends, which the Python
 * sidecar reads and `server/` never will — checking those against the Node
 * source would be a false positive that teaches the next reader to ignore this
 * file. The invariant that actually holds is narrower: a variable handed to
 * the SERVER container has to be one the server reads.
 */
function serviceEnv(source, service) {
    const lines = source.split('\n');
    const start = lines.findIndex((l) => new RegExp(`^\\s{2}${service}:\\s*$`).test(l));
    if (start === -1) throw new Error(`service ${service} not found in compose file`);
    const out = [];
    let inEnv = false;
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s{2}\S/.test(line)) break;                 // next service
        if (/^\s{4}environment:\s*$/.test(line)) { inEnv = true; continue; }
        if (inEnv && /^\s{4}\S/.test(line)) inEnv = false; // next key at service level
        if (!inEnv) continue;
        const m = line.match(/^\s*-\s*([A-Z0-9_]+)=(.*)$/);
        if (m) out.push({ name: m[1], value: m[2].trim() });
    }
    return out;
}

/** Guard-ish entries on the server service. */
function guardEnvAssignments(source) {
    return serviceEnv(source, 'server').filter((e) => /GUARD|PII/.test(e.name));
}

test('every guard variable the compose files set is one the server actually reads', () => {
    const read_ = envNamesReadByServer();
    const orphans = [];
    for (const file of COMPOSE_FILES) {
        for (const { name } of guardEnvAssignments(read(file))) {
            if (!read_.has(name)) orphans.push(`${file}: ${name}`);
        }
    }
    assert.deepStrictEqual(
        orphans,
        [],
        'compose sets a guard variable no code consumes — it reads as wired and does nothing:\n'
        + orphans.join('\n'),
    );
});

test('the resolver reads PII_SERVICE_URL, and both compose files set that name', async () => {
    // The whole defect in one pair of lines: compose hands the container a
    // name, and the resolver has to be the thing that reads it. Asked of the
    // resolver by running it — a config store that answers nothing, so the
    // env branch is the one under test.
    const { getGuardEndpoint, invalidateGuardEndpointCache } = require('./guardEndpoint');
    const before = { url: process.env.PII_SERVICE_URL, key: process.env.PII_SERVICE_API_KEY };
    try {
        process.env.PII_SERVICE_URL = 'http://guard-service:8100';
        process.env.PII_SERVICE_API_KEY = 'k';
        invalidateGuardEndpointCache();
        assert.deepStrictEqual(await getGuardEndpoint(), { url: 'http://guard-service:8100', apiKey: 'k' },
            'guardEndpoint.js no longer reads PII_SERVICE_URL — if the resolver was renamed, the '
            + 'compose files and selfhost.sh have to move with it');

        delete process.env.PII_SERVICE_URL;
        invalidateGuardEndpointCache();
        assert.strictEqual((await getGuardEndpoint()).url, null,
            'and an unset name is "not configured" — null, so callers fall open instead of blocking');
    } finally {
        if (before.url === undefined) delete process.env.PII_SERVICE_URL; else process.env.PII_SERVICE_URL = before.url;
        if (before.key === undefined) delete process.env.PII_SERVICE_API_KEY; else process.env.PII_SERVICE_API_KEY = before.key;
        invalidateGuardEndpointCache();
    }

    for (const file of COMPOSE_FILES) {
        const names = guardEnvAssignments(read(file)).map((e) => e.name);
        assert.ok(
            names.includes('PII_SERVICE_URL'),
            `${file} does not set PII_SERVICE_URL, so a stack built from it cannot reach the guard`,
        );
    }
});

test('the default is empty exactly where the guard sits behind a profile', () => {
    // NOT "empty everywhere". The rule is finer than that, and getting it wrong
    // in either direction breaks something:
    //
    //   guard behind `profiles: [guard]`  → a non-empty default points a
    //     core-only stack at a host that is not running. That is "configured but
    //     unreachable", which degrades and then applies piiFailureMode —
    //     fail_closed by default — so the install starts BLOCKING messages.
    //
    //   guard unconditional in the file   → an empty default means detection is
    //     simply off in a stack that ships a running guard. Silently off, which
    //     is the defect this whole file exists for.
    //
    // So the assertion is derived per file from whether guard-service is
    // profile-gated there, rather than pinned to one answer.
    for (const file of COMPOSE_FILES) {
        const src = read(file);
        const entry = guardEnvAssignments(src).find((e) => e.name === 'PII_SERVICE_URL');
        assert.ok(entry, `${file} has no PII_SERVICE_URL entry`);

        // Anchored on the SERVICE DEFINITION (two-space indent at line start),
        // not on any mention: both files name `http://guard-service:8100`
        // inside a comment or an env value further up, and a plain indexOf
        // lands there and reads the wrong block.
        const defAt = src.search(/^ {2}guard-service:\s*$/m);
        assert.ok(defAt > -1, `${file} has no guard-service service definition`);
        const guardBlock = src.slice(defAt, defAt + 800);
        const gated = /^\s+profiles:\s*\[[^\]]*guard/m.test(guardBlock);

        if (gated) {
            assert.match(
                entry.value,
                /^\$\{PII_SERVICE_URL:-\}$/,
                `${file} gates guard-service behind a profile but gives PII_SERVICE_URL a non-empty `
                + `default (${entry.value}). A stack without that profile would be pushed onto the `
                + 'fail-closed path and start blocking messages.',
            );
        } else {
            assert.match(
                entry.value,
                /^\$\{PII_SERVICE_URL:-\S+\}$/,
                `${file} runs guard-service unconditionally, so leaving PII_SERVICE_URL empty turns `
                + 'detection off in a stack that ships a working guard.',
            );
        }
    }
});

test('selfhost.sh wires the guard, and only when the guard profile is part of the run', () => {
    const sh = read('selfhost.sh');
    assert.match(sh, /wire_guard\(\)/, 'selfhost.sh no longer defines wire_guard()');
    assert.match(sh, /^\s*wire_guard$/m, 'wire_guard is defined but never called from install()');

    const body = sh.slice(sh.indexOf('wire_guard()'), sh.indexOf('wire_guard()') + 1400);
    assert.match(
        body,
        /guard/,
        'wire_guard does not look at the profile list — it would wire a guard that is not running',
    );
    assert.match(
        body,
        /export PII_SERVICE_URL=/,
        'wire_guard does not export PII_SERVICE_URL, so compose still receives the empty default',
    );
    assert.match(
        body,
        /PII_SERVICE_URL:-/,
        'wire_guard overwrites an operator-supplied PII_SERVICE_URL instead of only filling a blank',
    );
});

test('the boot sequence says out loud when detection is off', () => {
    // The per-call log line in detect.js is not enough: it only appears when
    // something asks for a scan, in a stream nobody is reading. An operator
    // who just started the stack is looking at the console right then.
    //
    // TEXTUAL, and the reason is the caller: this check lives inside
    // runStartupTasks(), which opens the database, starts the scheduler, the
    // licence refresh and a dozen other jobs. Driving it to read one log line
    // would stand up half the server, and forgetting the line is SILENT —
    // every other test in the tree stays green while a privacy feature is
    // simply off. A grep over the one file that carries it is the cheapest
    // true statement of that.
    const boot = read('server/boot/startupTasks.js');
    assert.match(
        boot,
        /getGuardEndpoint/,
        'startupTasks no longer checks whether the guard is configured at boot',
    );
    assert.match(
        boot,
        /NOT CONFIGURED/,
        'the boot check no longer states plainly that detection is off',
    );
});
