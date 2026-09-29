/**
 * Outbound n8n calls verify certificates unless somebody opted out on purpose.
 *
 * The "Test connection" route once passed `rejectUnauthorized: false`
 * unconditionally: the one place an admin uses to decide whether the
 * integration is sound was the one place that accepted any certificate. The
 * policy now lives in exactly one module, integrations/n8nHttp.js, and what
 * that policy DOES — verify by default, opt out only on the documented
 * environment flag — is tested there, behaviourally.
 *
 * ── WHY THIS ONE READS THE SOURCE ───────────────────────────────────
 * What is left here cannot be asked of a running program: it is "no file in
 * this set configures TLS on its own, and none of them reaches the network
 * except through n8nHttp". That is a statement about every line of three
 * files, including the paths no test drives and the ones not written yet. A
 * behavioural test can only prove that the requests it happens to trigger are
 * safe — and the original bug lived on exactly such a path, the admin's
 * one-off "Test connection" click, which nothing else exercises. A second
 * `https.Agent({ rejectUnauthorized: false })` added tomorrow to a branch
 * nobody calls in tests is the failure this file exists to catch.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.resolve(__dirname, '../../..');
const read = (rel) => fs.readFileSync(path.join(SERVER, rel), 'utf8');

const CALLERS = ['routes/ai/config/integrations.js', 'integrations/n8nTools.js', 'integrations/n8nWorkflowTools.js'];

test('no n8n caller configures TLS itself', () => {
    for (const rel of CALLERS) {
        const src = read(rel);
        assert.ok(!/rejectUnauthorized|https\.Agent|N8N_ALLOW_INSECURE_TLS/.test(src),
            `${rel} carries its own certificate policy; integrations/n8nHttp.js is the one place for it`);
    }
});

test('every n8n caller fetches through n8nHttp', () => {
    for (const rel of CALLERS) {
        const src = read(rel);
        assert.match(src, /require\('(\.\/|\.\.\/\.\.\/\.\.\/integrations\/)n8nHttp'\)/, `${rel} does not require n8nHttp`);
        assert.ok(!/\bfetch\(/.test(src.replace(/n8nFetch\(/g, '')), `${rel} calls fetch() directly`);
    }
});
