// @typecheck
/**
 * The marking port: core asks, the feature answers.
 *
 * The port must be inert when nothing has registered — a build without the
 * compliance module renders documents, it does not crash — and the document
 * runner must reach the org's policy through it, carrying the AI steps the
 * document actually drew on.
 *
 * ONE test here reads a file instead of running it, and it is the last one:
 * boot/startupTasks.js registering the resolver. The failure mode of
 * forgetting that line is silent — every generated document goes out unmarked
 * and everything else still passes — and the only caller of the registration
 * is `runStartupTasks()`, which also starts a dozen background jobs and opens
 * the DB. There is no seam to test it through: the claim is about that one
 * line existing in that one file, so the test says exactly that.
 *
 * "core must not require the compliance feature" is not restated here; it is
 * the layering rule in server/layering.test.js, enforced across every file.
 *
 * Run: cd server && node --test --test-force-exit core/automationRunner/documentMarking.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const port = require('./documentMarking');

test('no resolver registered → no marking, no throw', async () => {
    port.setMarkingResolver(null);
    assert.strictEqual(port.hasMarkingResolver(), false);
    assert.strictEqual(await port.resolveMarking('org1', { automationId: 'a1' }), null);
});

test('the registered resolver gets the org and the render info verbatim', async () => {
    const calls = [];
    port.setMarkingResolver(async (orgId, info) => { calls.push([orgId, info]); return { enabled: true, footer_text: 'x' }; });
    assert.strictEqual(port.hasMarkingResolver(), true);
    const info = { automationId: 'a1', aiStepIds: ['s1'], provider: 'anthropic' };
    const out = await port.resolveMarking('org7', info);
    assert.deepStrictEqual(out, { enabled: true, footer_text: 'x' });
    assert.deepStrictEqual(calls, [['org7', info]]);
    port.setMarkingResolver(null);
});

test('a non-function registration is refused rather than stored', async () => {
    port.setMarkingResolver(() => ({ enabled: true }));
    port.setMarkingResolver('nope');
    assert.strictEqual(port.hasMarkingResolver(), false);
});

// The document runner's side of the port (execDocument, the automation module's) is in
// documentMarking.automation.test.js.

// ── Source-level, and why: see the file header ────────────────────────

test('boot wires the compliance resolver into the port', () => {
    // Genuinely textual — see the file header: no seam exists to call
    // runStartupTasks() for real without starting a dozen other background
    // jobs and opening the DB.
    // The compliance block is runStartupTasks()'s startRetentionAndComplianceJobs phase. The
    // compliance module's own registration line (firstParty/compliance.register.js) is checked in
    // documentMarking.compliance.test.js; here the core's half: the channel and the wiring.
    const ports = fs.readFileSync(path.join(__dirname, '..', '..', 'boot', 'ports.js'), 'utf8');
    assert.ok(ports.includes("openChannel('boot/ports')"), 'boot/ports.js wirePorts must open the channel the compliance module wires the resolver on');
    const jobs = fs.readFileSync(path.join(__dirname, '..', '..', 'boot', 'startupJobs.js'), 'utf8');
    assert.ok(/require\('\.\/ports'\)\.wirePorts\(\{ compliance: moduleLoaded\('compliance'\) \}\)/.test(jobs),
        'boot/startupJobs.js must wire the ports with whether the compliance module loaded');
});
