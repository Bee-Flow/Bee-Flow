#!/usr/bin/env node
/**
 * The mobile job in ci.yml deliberately does NOT fire on server/package.json.
 *
 * Its `mobile:` filter negates `server/package.json` and `server/package-lock.json`
 * after `server/**`, so dependabot's server bumps stop re-running the whole
 * mobile pipeline for a change that cannot alter a mobile test outcome. That
 * exclusion is only safe while two invariants hold, and BOTH of them live on
 * the server side of the repository:
 *
 *   1. server/ stays CommonJS. mobile/src/features/automate/catalogLockstep
 *      .test.ts `require()`s server/appStudio/componentSpecs.js from a
 *      CommonJS jest-expo context. Flip `"type"` to `"module"` and that
 *      require breaks — on a commit for which the mobile job no longer fires
 *      to tell you.
 *   2. mobile's jest config still loads the server tree untransformed
 *      (SERVER_DIR in transformIgnorePatterns), because the server's
 *      node_modules are not installed in the mobile CI job.
 *
 * So they are asserted HERE, in a check that runs on commits touching only
 * server/package.json. Its runner is the `server` job in
 * .github/workflows/ci.yml, which fires on `server/**` with no manifest
 * exclusion — i.e. on exactly the commits the mobile job now skips —
 * and it is additionally picked up by `npm run test:scripts`.
 *
 * It asserts INVARIANTS, not a mirror of which server files the mobile tests
 * read. An enumeration would need editing every time someone adds a
 * `read('stores/formStore.js')` to serverContract.test.ts, and an unchecked
 * mirror is exactly what drifts. `server/**` is still matched in full, so no
 * coverage depends on a list here.
 *
 * Fail loudly, never skip: the server job's own header states the principle
 * — "a suite that self-skips when a container is missing protects nothing
 * where the bug gets written".
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

// 1. The server package is CommonJS.
const manifestPath = path.join(ROOT, 'server/package.json');
if (!fs.existsSync(manifestPath)) {
    problems.push(`server/package.json is missing at ${manifestPath}`);
} else {
    const type = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).type;
    if (type !== 'commonjs') {
        problems.push(
            `server/package.json has "type": ${JSON.stringify(type)}, expected "commonjs". ` +
                'mobile/src/features/automate/catalogLockstep.test.ts require()s ' +
                'server/appStudio/componentSpecs.js from a CommonJS jest-expo context, and ' +
                'the mobile CI job does not fire on this file to tell you it broke.',
        );
    }
}

// 2. Mobile still loads the server tree untransformed.
const jestConfigPath = path.join(ROOT, 'mobile/jest.config.js');
if (!fs.existsSync(jestConfigPath)) {
    problems.push(
        `mobile/jest.config.js is missing at ${jestConfigPath} — this check refuses to pass without reading it`,
    );
} else {
    const config = fs.readFileSync(jestConfigPath, 'utf8');
    // Inside the ARRAY, not merely somewhere in the file: the `const
    // SERVER_DIR = …` declaration would satisfy a bare `includes` while the
    // entry that actually does the work had been deleted from the list.
    const array = /transformIgnorePatterns:\s*\[([\s\S]*?)\]/.exec(config);
    if (!array) {
        problems.push('mobile/jest.config.js no longer has a transformIgnorePatterns array');
    } else if (!array[1].includes('SERVER_DIR')) {
        problems.push(
            "mobile/jest.config.js no longer mentions SERVER_DIR in transformIgnorePatterns. Without it the server's " +
                'uninstalled node_modules become reachable through Babel in the mobile CI job, ' +
                "and the mobile CI job's server-manifest exclusion stops being safe.",
        );
    }
}

if (problems.length > 0) {
    for (const p of problems) console.error(`server-manifest: ${p}`);
    process.exit(1);
}

console.log('server-manifest: server/ is CommonJS and mobile/jest.config.js still loads it untransformed');
