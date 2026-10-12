/**
 * The cross-stage scan (design 3.1): a UAT payload that points at a PRD or a
 * Dev part is blocking. Ownership is read from a real Postgres (pglite) with
 * only some part tables present, as on an installation without every module.
 *
 * Run: cd server && node --test projects/stages/crossStageScan.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { scanStagePayloads, memberIdsByProject, foreignOwners, scanAgainst } = require('./crossStageScan');

const { pg, db } = pgliteDb();
const solutionStageStore = { listStages: async () => [{ projectId: 'uat-1', stage: 'uat' }, { projectId: 'prd-1', stage: 'prd' }] };
const deps = { db, solutionStageStore };

before(async () => {
    // automations, studio_apps, agents, skills and studio_documents are absent on purpose.
    await pg.exec(`
        CREATE TABLE projects (id TEXT PRIMARY KEY, knowledge_base_ids JSONB DEFAULT '[]'::jsonb);
        CREATE TABLE datatables (id TEXT PRIMARY KEY, project_id TEXT);
        CREATE TABLE webpages (id TEXT PRIMARY KEY, project_id TEXT);
        INSERT INTO projects VALUES ('sol-1', '["kb-dev"]'), ('uat-1', '["kb-uat"]'), ('prd-1', '["kb-prd"]');
        INSERT INTO datatables VALUES ('tbl_dev00000001', 'sol-1'), ('tbl_uat00000001', 'uat-1'), ('tbl_prd00000001', 'prd-1'),
                                      ('tbl_org00000001', NULL);
        INSERT INTO webpages VALUES ('web-prd-1', 'prd-1');`);
});
after(async () => { await pg.close(); });

test('memberIdsByProject reads every part table there is', async () => {
    const byProject = await memberIdsByProject(['sol-1', 'prd-1'], deps);
    assert.deepStrictEqual([...byProject.get('sol-1')].sort(), ['kb-dev', 'tbl_dev00000001']);
    assert.deepStrictEqual([...byProject.get('prd-1')].sort(), ['kb-prd', 'tbl_prd00000001', 'web-prd-1']);
});

test('foreignOwners: Dev and the sibling stage, never the stage itself', async () => {
    const owners = await foreignOwners({ solutionId: 'sol-1', exceptProjectId: 'uat-1' }, deps);
    assert.strictEqual(owners.get('tbl_prd00000001').stage, 'prd');
    assert.strictEqual(owners.get('kb-dev').stage, 'dev');
    assert.ok(!owners.has('tbl_uat00000001'));
    assert.ok(!owners.has('tbl_org00000001'));
});

test('the scan catches a PRD table id in a UAT automation, and a Dev id in code', async () => {
    const payloads = [{
        ref: 'aut_1', kind: 'automation', payload: {
            ref: 'aut_1', definition: {
                steps: [
                    { id: 's1', type: 'datatable', op: 'list_rows', datatableId: 'tbl_prd00000001' },
                    { id: 's2', type: 'datatable', op: 'list_rows', datatableId: 'tbl_uat00000001' },
                    { id: 's3', type: 'code', code: 'return lookup("kb-dev")' },
                    { id: 's4', type: 'ai_step', knowledgeBaseIds: ['kb-uat', 'kb-prd'] },
                ],
            },
        },
    }];
    const findings = await scanStagePayloads({ solutionId: 'sol-1', stageProjectId: 'uat-1', payloads }, deps);
    const byStage = findings.map(f => [f.code, f.severity, f.ownerStage, f.stepId || f.path]);
    assert.deepStrictEqual(byStage, [
        ['stage.cross_reference', 'blocking', 'prd', 's1'],
        ['stage.cross_reference', 'blocking', 'prd', 's4'],
        ['stage.cross_reference', 'blocking', 'dev', 'definition.steps[2].code'],
    ]);
    assert.ok(findings.every(f => !JSON.stringify(f).includes('tbl_prd00000001')), 'a finding names no id');
});

test('a clean UAT payload has no findings; no owners means nothing to scan', async () => {
    const payloads = [{ ref: 'web_1', kind: 'webpages', payload: { bridgeGrants: { tables: [{ datatableId: 'tbl_uat00000001' }] }, knowledgeBaseIds: ['kb-uat'] } }];
    assert.deepStrictEqual(await scanStagePayloads({ solutionId: 'sol-1', stageProjectId: 'uat-1', payloads }, deps), []);
    assert.deepStrictEqual(scanAgainst(payloads, new Map()), []);
    const injected = await scanStagePayloads({ solutionId: 'sol-1', stageProjectId: 'uat-1', payloads }, {
        solutionStageStore, ownersOf: async () => new Map([['kb-uat', { projectId: 'x', stage: 'prd' }]]),
    });
    assert.strictEqual(injected.length, 1);
});
