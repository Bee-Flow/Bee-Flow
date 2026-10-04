/**
 * Every AGENT dispatch that borrows the owner's connection must ask `actAs`.
 *
 * `config.tools[app].actAs` is the owner's answer to "may this run on MY
 * connection?". It was read on the streaming route (toolRoundExecutor) and not
 * on the non-streaming one (chatWithAgent, which the support responder uses),
 * so the same stored "as the person asking" was obeyed or ignored depending on
 * which route a caller happened to land on. An owner cannot see that
 * difference, which makes it the same silently-ignored setting the grant layer
 * was built to abolish — a limit that half-works is still a limit that lies.
 *
 * Fixing those two is not what stops this recurring; this tripwire is. Any
 * file that resolves a LENT identity for `resourceType: 'agent'` must also go
 * through `mayLendOwnerConnection`, and a third dispatch site fails here until
 * it does.
 *
 * Only agent-scoped lending is in scope: `core/automationRunner/execAi.js`
 * lends for `resourceType: 'automation'`, where the grant is the automation's own
 * and there is no agent config carrying an `actAs` to honour.
 *
 * Run: cd server && node --test --test-force-exit core/agentRuntime/lending.callSites.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_ROOT = path.resolve(__dirname, '..', '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'coverage', 'dist', 'uploads', 'public']);

const RESOLVE_RE = /resolveEffectiveIdentity\s*\(/;
const AGENT_SCOPED_RE = /resourceType:\s*'agent'/;
const GATE_RE = /mayLendOwnerConnection/;

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            walk(path.join(dir, entry.name), out);
        } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
            out.push(path.join(dir, entry.name));
        }
    }
    return out;
}

test('every agent-scoped lending call site consults the actAs gate', () => {
    const offenders = [];
    let sites = 0;
    for (const file of walk(SERVER_ROOT)) {
        const src = fs.readFileSync(file, 'utf8');
        if (!RESOLVE_RE.test(src) || !AGENT_SCOPED_RE.test(src)) continue;
        sites++;
        if (!GATE_RE.test(src)) offenders.push(path.relative(SERVER_ROOT, file));
    }

    assert.equal(offenders.length, 0,
        `these borrow the owner's connection for an agent without asking the owner's actAs: ${offenders.join(', ')}`);
    // The count is asserted so DELETING a gate cannot pass this test by making
    // its call site invisible — the two sites are the streaming and the
    // non-streaming agent dispatch. A third one is a deliberate, reviewable
    // change to this number.
    assert.equal(sites, 2, `expected exactly 2 agent lending dispatch sites, found ${sites}`);
});
