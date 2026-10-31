#!/usr/bin/env node
/**
 * gen-routes-contract — server/auth/routes.contract.json from the server's own router.
 *
 *   node scripts/gen-routes-contract.mjs           # (re)write the contract
 *   node scripts/gen-routes-contract.mjs --check   # exit 1 when the router differs
 *
 * The contract records, per route, the strongest gate class its middleware
 * chain carries (server/auth/routeContract.js). server/routes.contract.test.js
 * holds the router to it on every server test run; this script is how the file
 * is brought up to date after a route change. The diff is the review: a class
 * that went down is a route that lets more callers through than before.
 *
 * Like gen-api-reference.mjs it loads the app in a child process, so it needs
 * server/node_modules and stays out of check:fast.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';
import { walkServer } from './gen-api-reference.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server');

/**
 * @param {string[]} argv
 * @param {{ walked?: unknown, server?: string, out?: (s: string) => void }} [deps]
 * @returns {number} the exit code
 */
export function main(argv, { walked, server = SERVER, out = (s) => process.stdout.write(s) } = {}) {
    const observe = require(path.join(server, 'testUtils', 'routeContractObserve.js'));
    const rc = require(path.join(server, 'auth', 'routeContract.js'));
    const check = argv.includes('--check');
    const routes = observe.observeContract(/** @type {any} */ (walked ?? walkServer({ server })), { server });
    const file = observe.contractPath(server);
    if (check) {
        const recorded = observe.readContract(server);
        if (!recorded) { out(`${path.relative(ROOT, file)} is missing: run node scripts/gen-routes-contract.mjs\n`); return 1; }
        const diff = rc.compareContract(recorded.routes || {}, routes);
        const bad = diff.missing.length + diff.stale.length + diff.weakened.length + diff.unaccounted.length + diff.openWithoutReason.length;
        if (bad === 0) { out(`✅ routes contract: ${Object.keys(routes).length} routes, no change\n`); return 0; }
        out(`❌ routes contract differs from the router:\n${rc.describeDiff(diff)}\nRun node scripts/gen-routes-contract.mjs and review the diff.\n`);
        return 1;
    }
    const text = observe.renderContract(routes);
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    fs.writeFileSync(file, text);
    const n = Object.keys(routes).length;
    const unaccounted = Object.entries(routes).filter(([, e]) => e.gate === 'unaccounted').map(([id]) => id);
    out(`${before === text ? 'unchanged' : 'wrote'} ${path.relative(ROOT, file)}: ${n} routes\n`);
    if (unaccounted.length) {
        out(`${unaccounted.length} route(s) have no gate anywhere; the test refuses them until they are gated, declared in auth/accessRegistry.js or listed with a reason in auth/openRoutes.js:\n${unaccounted.map((id) => `  ${id}`).join('\n')}\n`);
        return 1;
    }
    return 0;
}

if (isEntryPoint(import.meta.url)) {
    process.exit(main(process.argv.slice(2)));
}
