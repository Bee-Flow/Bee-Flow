/**
 * The stage-only release checks (design 6.1 items 2 and 7, 4.2, D20).
 *
 * Run: cd server && node --test projects/stages/releaseChecks.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { releaseChecks, stageOnlyFindings } = require('./releaseChecks');

const manifest = (over = {}) => ({
    solution: {
        entities: {
            automations: [{
                ref: 'aut_1', definition: {
                    vars: { region: 'eu', api_base: 'x' },
                    steps: [
                        { id: 'w', type: 'datatable', op: 'add_row', datatableId: { $ref: 'dt_1' } },
                        { id: 'r', type: 'datatable', op: 'list_rows', datatableId: { $ref: 'dt_1' } },
                        { id: 'c', type: 'http_request', cacheInto: { datatableId: { $ref: 'dt_2' } } },
                    ],
                },
            }],
            webpages: [{ ref: 'web_1', bridgeGrants: { tables: [{ datatableId: { $ref: 'dt_1' }, mode: 'readwrite' }, { datatableId: { $ref: 'dt_2' }, mode: 'read' }] } }],
            datatables: [{ ref: 'dt_1', key: 'prices' }, { ref: 'dt_2', key: 'cache' }],
        },
        report: { problems: [{ code: 'cross_owner', ref: 'app_1' }, { code: 'external', ref: 'aut_1' }] },
        slots: [],
        ...over,
    },
});

const codes = (findings) => findings.map(f => `${f.severity}:${f.code}${f.ref ? `@${f.ref}` : ''}${f.name ? `#${f.name}` : ''}`);

test('every stage-only finding, blocking unless repairable', () => {
    const findings = stageOnlyFindings({
        manifest: manifest(),
        rawIds: [
            { ref: 'aut_1', path: 'definition.steps[3].code', id: 'aut-dev-9' },
            { ref: 'web_1', path: 'files.js', id: 'tbl_aaaaaaaaaaaa', substitutable: true },
        ],
        captureFindings: [
            { code: 'webpage.extra_files', severity: 'blocking', ref: 'web_1', count: 2 },
            { code: 'agent.skill_not_in_solution', severity: 'blocking', ref: 'agt_1' },
            { code: 'webpage.agent_not_in_solution', severity: 'blocking', ref: 'web_1' },
            { code: 'app.data_model_unreadable', severity: 'blocking', ref: 'app_1' },
        ],
        variables: [{ name: 'region' }, { name: 'api_token' }, { name: 'unused' }],
        referenceRefs: new Set(['dt_1']),
        payloadFindings: [
            { code: 'reference.personal_data', severity: 'blocking', ref: 'dt_1', columns: [{ key: 'email' }] },
            { code: 'kb.personal_data', severity: 'blocking', ref: 'kb_1', acknowledgeable: true },
            { code: 'kb.document_unhashed', severity: 'warning', ref: 'kb_1' },
        ],
    });
    assert.deepStrictEqual(codes(findings), [
        'blocking:webpage.extra_files@web_1',
        'blocking:agent.skill_not_in_solution@agt_1',
        'blocking:webpage.agent_not_in_solution@web_1',
        'blocking:app.data_model_unreadable@app_1',
        'blocking:release.raw_id_reference@aut_1',
        'warning:release.table_token@web_1',
        'blocking:release.cross_owner@app_1',
        'blocking:variable.secret_name#api_token',
        'blocking:variable.shadowed@aut_1#region',
        'blocking:reference.written_at_runtime@aut_1',
        'blocking:reference.written_at_runtime@web_1',
        'blocking:reference.personal_data@dt_1',
        'blocking:kb.personal_data@kb_1',
        'warning:kb.document_unhashed@kb_1',
    ]);
    assert.ok(findings.every(f => !JSON.stringify(f).includes('aut-dev-9')), 'a raw-id finding names the path, not the id');
    assert.ok(findings.find(f => f.code === 'variable.secret_name').message);
});

test('a reading automation and a cache into a non-reference table are fine', () => {
    const findings = stageOnlyFindings({ manifest: manifest(), referenceRefs: ['dt_2'] });
    // dt_2 is written by the http cache only.
    assert.deepStrictEqual(codes(findings.filter(f => f.code === 'reference.written_at_runtime')), ['blocking:reference.written_at_runtime@aut_1']);
});

test('releaseChecks: a Dev part pointing at a stage part, in an entity or as a slot suggestion', async () => {
    const m = manifest({
        slots: [
            { slot: 'table:customers', kind: 'table', ref: 'aut_1', suggested: { datatableId: 'tbl_prd00000001' } },
            { slot: 'kb:aut_1:knowledgeBaseIds:s', kind: 'knowledge_base', ref: 'aut_1', suggested: { kbIds: ['kb-org'] } },
        ],
    });
    m.solution.entities.automations[0].definition.steps.push({ id: 'k', type: 'code', code: '"kb-uat"' });
    const deps = {
        solutionStageStore: { listStages: async () => [{ projectId: 'uat-1', stage: 'uat' }, { projectId: 'prd-1', stage: 'prd' }] },
        ownersOf: async (projects) => {
            assert.deepStrictEqual(projects.map(p => p.stage), ['uat', 'prd'], 'Dev itself is not foreign to a Dev release');
            return new Map([['tbl_prd00000001', projects[1]], ['kb-uat', projects[0]]]);
        },
    };
    const out = await releaseChecks({ solutionId: 'sol-1', manifest: m, variables: [] }, deps);
    const cross = out.findings.filter(f => f.code === 'release.cross_stage_reference');
    assert.deepStrictEqual(cross.map(f => [f.ref, f.ownerStage, f.slot || f.path]), [
        ['aut_1', 'uat', 'definition.steps[3].code'],
        ['aut_1', 'prd', 'table:customers'],
    ]);
    assert.strictEqual(out.blocked, true);
    const clean = await releaseChecks({ solutionId: 'sol-1', manifest: { solution: { entities: {} } } }, { ...deps, ownersOf: async () => new Map() });
    assert.deepStrictEqual(clean, { blocked: false, findings: [] });
});
