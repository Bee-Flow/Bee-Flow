// @vitest-environment node
/**
 * Lockstep proof, editor half: this facade returns exactly what the editor's
 * hand-kept copy returned before the shared ops moved to
 * server/shared/appDefinition/ (lockstep.golden.json; same sample definition,
 * same scenario and seeded ids as the server half,
 * server/shared/appDefinition/definitionOps.lockstep.test.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import * as ops from './definitionOps';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.resolve(HERE, '../../../../../../../server/shared/appDefinition');
const require = createRequire(import.meta.url);

type Golden = { server: Record<string, unknown>; client: Record<string, unknown> };
type Fixture = { runScenario: (facade: object) => Record<string, unknown> };

describe('state/definitionOps — lockstep with the server', () => {
    it('returns what the editor copy returned before the move, op for op', () => {
        const golden: Golden = JSON.parse(fs.readFileSync(path.join(SHARED_DIR, 'lockstep.golden.json'), 'utf8'));
        const fixture: Fixture = require(path.join(SHARED_DIR, 'lockstep.fixture.mjs'));
        expect(fixture.runScenario(ops)).toEqual(golden.client);
    });
});
