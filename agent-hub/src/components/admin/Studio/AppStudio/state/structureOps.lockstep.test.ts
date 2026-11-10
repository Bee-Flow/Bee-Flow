// @vitest-environment node
/**
 * Lockstep proof for the section and screen ops: the editor's state/structureOps returns, case
 * for case, what the server facade returns (server/shared/appDefinition/lockstep.golden.json,
 * the same sample definition and seeded ids as definitionOps.lockstep.test.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import * as ops from './structureOps';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.resolve(HERE, '../../../../../../../server/shared/appDefinition');
const require = createRequire(import.meta.url);

type Golden = { server: Record<string, unknown> };
type Fixture = { runScenario: (facade: object) => Record<string, unknown> };

const OPS = ['updateSection', 'moveSection', 'duplicateSection', 'moveScreen', 'duplicateScreen'];

describe('state/structureOps — lockstep with the server', () => {
    it('returns the server golden for every section and screen op case', () => {
        const golden: Golden = JSON.parse(fs.readFileSync(path.join(SHARED_DIR, 'lockstep.golden.json'), 'utf8'));
        const fixture: Fixture = require(path.join(SHARED_DIR, 'lockstep.fixture.mjs'));
        const actual = fixture.runScenario(ops);
        const names = Object.keys(actual);
        expect(names.length).toBeGreaterThanOrEqual(18);
        for (const name of names) expect(OPS.some((op) => name.startsWith(`${op}.`))).toBe(true);
        for (const name of names) expect({ name, result: actual[name] }).toEqual({ name, result: golden.server[name] });
    });
});
