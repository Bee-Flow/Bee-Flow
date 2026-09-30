'use strict';

/**
 * Live project names for the admin check table: the ids a row refers to, and
 * the current names of only this organisation's projects (real Postgres).
 *
 * Run: cd server && node --test compliance/projects/projectNames.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');

const { applyProjectCheckSchema, queryOf } = require('./testSchema');
const { projectIdsOfRow, projectNames } = require('./projectNames');

const pg = new PGlite();
after(() => pg.close());

test('a row refers to its subject project, its evidence project and its offenders', () => {
    assert.deepStrictEqual([...projectIdsOfRow({ scope_id: 'project:p1', evidence: { offenders: [{ project_id: 'p2' }, { project_id: 'p1' }] } })].sort(), ['p1', 'p2']);
    assert.deepStrictEqual([...projectIdsOfRow({ scope_id: 'project_chat:c1', evidence: { project_id: 'p3' } })], ['p3']);
    assert.deepStrictEqual([...projectIdsOfRow({ scope_id: null, evidence: null })], []);
});

test('names are resolved for this organisation\'s projects only', async () => {
    await applyProjectCheckSchema(pg, { versions: false });
    await pg.exec(`
        INSERT INTO projects (id, name, owner_id, organization_id, kind) VALUES
            ('p1', 'Launch', 'u1', 'org1', 'workspace'), ('p2', 'Theirs', 'u2', 'org2', 'workspace'), ('p3', 'Solo', 'u3', '', 'workspace');
    `);
    const q = queryOf(pg);
    assert.deepStrictEqual(await projectNames('org1', ['p1', 'p2', 'p3'], q), { p1: 'Launch' });
    assert.deepStrictEqual(await projectNames('default', ['p3'], q), { p3: 'Solo' });
    assert.deepStrictEqual(await projectNames('org1', [], q), {});
});
