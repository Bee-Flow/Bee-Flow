/**
 * Smoke-test suite for the legacy GDPR / AI Act / ISO 27001 compliance checks.
 *
 * These 41 check modules have no colocated *.test.js of their own — this file
 * is their only coverage. It used to be `smoke.js` with a hand-rolled runner,
 * which meant `scripts/run-tests.mjs` (it collects *.test.js / *.test.mjs) never
 * saw it: the suite went red during the evidence-chain rewrite and nothing said
 * so for weeks. It is now a normal colocated test file — the repo convention —
 * so `npm test` runs it and a broken scenario breaks the build.
 *
 * Each scenario module is one top-level test; `harness.bindRunner(t)` turns the
 * scenarios' own `t('…', fn)` calls into named subtests of it. The scenarios
 * share monkey-patched store singletons and must keep running in order, which
 * is what node:test does for top-level tests inside a file.
 *
 * Run:  node --test --test-force-exit compliance/__tests__/smoke.test.js
 */

const { test } = require('node:test');

const harness = require('./smoke/harness');

const SCENARIOS = [
    ['GDPR — safeguards', require('./smoke/gdpr-safeguards')],
    ['AI Act — agent transparency', require('./smoke/aia-agent-transparency')],
    ['GDPR — data lifecycle', require('./smoke/gdpr-data-lifecycle')],
    ['AI Act — oversight', require('./smoke/aia-oversight')],
    ['ISO 27001 — platform controls', require('./smoke/iso-platform-controls')],
    ['ISO 27001 — governance registers', require('./smoke/iso-governance')],
    ['ISO 27001 — mail and TLS', require('./smoke/iso-mail-and-tls')],
    ['ISO 27001 — GitHub repositories', require('./smoke/iso-github-repos')],
    ['ISO 27001 — cloud infrastructure', require('./smoke/iso-cloud-infrastructure')],
    ['ISO 27001 — directory identity', require('./smoke/iso-directory-identity')],
    ['ISO 27001 — workplace connectors', require('./smoke/iso-workplace-connectors')],
];

// The scenarios print their own section headers, written for the days they
// were a standalone script. Under the test runner every assertion is already a
// named subtest, and that raw stdout is interleaved with the runner's
// serialised report over the same pipe — enough of it and a `--test-force-exit`
// run (how `npm test` invokes node) truncates a message mid-frame and the file
// fails with "Unable to deserialize cloned data". Keep the file quiet.
const quiet = (fn) => async (...args) => {
    const log = console.log;
    console.log = () => {};
    try { return await fn(...args); } finally { console.log = log; }
};

for (const [name, scenario] of SCENARIOS) {
    test(name, quiet(async (t) => {
        harness.bindRunner(t);
        try {
            await scenario();
        } finally {
            harness.bindRunner(null);
        }
    }));
}
