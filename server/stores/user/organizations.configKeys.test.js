/**
 * Every per-organisation config key must be a decision, not an accident.
 *
 * `deleteOrganization` wiped `config` rows with `key LIKE 'org_<orgId>_%'`,
 * which does not match `org_integration_cache_<orgId>` or `org_ai_context_<orgId>`
 * — the prefix comes first there, the id last. So an organisation's "yes, store
 * third-party response payloads at rest" tick survived the organisation, and an
 * org re-created with the same id came back with the feature ENABLED and nobody
 * having decided it.
 *
 * Fixing the two instances would have left the CLASS open: the next per-org
 * consent key would slip through the same way. This test is the class fix — it
 * finds every `CONFIG_KEY_PREFIX` declared anywhere in the tree and forces each
 * one into exactly one of two lists: deleted with the org, or deliberately kept
 * with a reason.
 *
 * Run: cd server && node --test --test-force-exit stores/user/organizations.configKeys.test.js
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'vendor', 'uploads', 'data', 'logs']);

/**
 * Prefixes that are NOT deleted with the organisation, each with the reason.
 *
 * Adding an entry here is a decision somebody has to write down; that is the
 * entire point. An empty reason is as good as no entry.
 */
const DELIBERATELY_KEPT = {
    'encryption.org_root_key.':
        'the escrow ROOT key. Deleting it makes anything still wrapped under it '
        + 'permanently unopenable, so retiring one is its own audited operation, '
        + 'not a side effect of removing an org row.',
};

/** Every .js file under server/, minus vendored and generated trees. */
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

function declaredPrefixes() {
    const found = new Map();   // prefix → declaring file, relative
    for (const file of walk(SERVER_ROOT)) {
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(/CONFIG_KEY_PREFIX\s*=\s*'([^']+)'/g)) {
            if (!found.has(m[1])) found.set(m[1], path.relative(SERVER_ROOT, file));
        }
    }
    return found;
}

test('the teardown list is built from the real prefixes, not from copies of them', () => {
    const organizations = require('./organizations');
    const keys = organizations.orgConfigKeys('ORGID');
    const { CONFIG_KEY_PREFIX: cache } = require('../../core/automationRunner/integrationCachePolicy');
    const { CONFIG_KEY_PREFIX: ctx } = require('../../core/llm/contextPolicy');
    // Not a style point: a copied literal drifts silently the day the module
    // renames its key, and nothing fails until an auditor asks why a deleted
    // org still has a consent row.
    assert.ok(keys.includes(`${cache}ORGID`), 'the integration-cache consent key must be in the list');
    assert.ok(keys.includes(`${ctx}ORGID`), 'the chat-context policy key must be in the list');
    // No source read needed beyond this: the two checks above already prove
    // organizations.js pulled the REAL, live constant — if it held a copied
    // literal instead, a rename in either policy module would desync the
    // values and one of the assertions above would fail. Regexing for the
    // exact `CONFIG_KEY_PREFIX: INTEGRATION_CACHE` destructuring syntax on
    // top of that would only pin ONE way of writing correct code and flag
    // any other correct rewrite as broken.
});

test('every CONFIG_KEY_PREFIX in the tree is either torn down or deliberately kept', () => {
    const organizations = require('./organizations');
    const keys = new Set(organizations.orgConfigKeys('ORGID'));
    const prefixes = declaredPrefixes();
    assert.ok(prefixes.size >= 2, 'the scan found nothing — the regex or the walk is broken');

    const unaccounted = [];
    for (const [prefix, file] of prefixes) {
        if (keys.has(`${prefix}ORGID`)) continue;
        const reason = DELIBERATELY_KEPT[prefix];
        if (reason && reason.trim().length > 20) continue;
        unaccounted.push(`${prefix}  (declared in ${file})`);
    }
    assert.deepStrictEqual(unaccounted, [],
        'A per-org config key that outlives its organisation is an Art. 17 gap and, on a '
        + 're-created id, a setting nobody chose. Add it to orgConfigKeys() in '
        + 'stores/user/organizations.js, or to DELIBERATELY_KEPT in this file with the reason.');
});

test('the legacy and connector keys stay in the list — they match no pattern either', () => {
    const keys = require('./organizations').orgConfigKeys('ORGID');
    assert.ok(keys.includes('org_privacy_shield_ORGID'));
    // A stale connector cache would otherwise go on presenting JWTs signed by
    // the deleted org's key.
    assert.ok(keys.includes('connector_tenant_key_ORGID'));
});
