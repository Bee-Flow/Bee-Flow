#!/usr/bin/env node
// @typecheck strict
/**
 * Rewrite the golden files of the Windmill converter
 * (automation/importers/windmill/fixtures/*.golden.json) from their fixtures.
 *
 * A golden change must be deliberate: run this after a converter change, read
 * the diff, and commit the goldens with the change that explains them.
 *
 * Usage: cd server && node automation/importers/windmill/regenGolden.mjs [name …]
 */

import { writeFileSync } from 'node:fs';
import { fixtureNames, goldenOf, goldenPath } from './goldenFixtures.mjs';

const wanted = process.argv.slice(2);
for (const name of wanted.length ? wanted : fixtureNames()) {
    writeFileSync(goldenPath(name), `${JSON.stringify(await goldenOf(name), null, 2)}\n`);
    process.stdout.write(`wrote ${name}.golden.json\n`);
}
