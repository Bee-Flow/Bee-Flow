/**
 * App Studio — the template FILE as it is written today, frozen.
 *
 * A file written by this build is read by older installations, and a file an older build
 * wrote is read by this one. So what an export looks like is a contract: a template that
 * carries nothing new (no uploaded files, nothing of schema 3) must keep producing these
 * exact bytes. The input is a literal, so the hash depends on buildExport alone.
 *
 * When this fails, the change made every existing export look different. Make the new part
 * emit-when-present instead of updating the hash.
 *
 * Run: cd server && node --test appStudio/templatePortability.golden.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { buildExport } = require('./templatePortability');

function literalTemplate() {
    return {
        id: 'utpl_0123456789abcdef',
        version: 3,
        title: 'Golden intake',
        description: 'A fixed template for the byte check',
        category: 'Van je team',
        icon: 'Inbox',
        tags: ['intake', 7, 'golden'],
        createdBy: 'user-1',
        organizationId: 'org-1',
        sourceAppId: 'app-1',
        definition: {
            schemaVersion: 2,
            meta: { name: 'Golden intake', icon: 'Inbox' },
            theme: { accent: '#3355ff' },
            screens: [{ id: 'scr_home', name: 'Home', sections: [{ id: 'sec_1', components: [{ id: 'cmp_t', type: 'text', props: { text: 'Hello' } }] }] }],
            actions: { act_run: { kind: 'run_automation', automationId: 'auto-live-123' } },
        },
        dataModel: { tables: [{ id: 'tbl_a', key: 'people', name: 'People', fields: [{ id: 'fld_1', key: 'name', type: 'text' }] }] },
        seed: { tbl_a: [{ $id: 'people_1', name: 'Ada' }] },
        datasets: [{ id: 'ds_1', name: 'All people', tableId: 'tbl_a', source: {}, descriptor: {} }],
    };
}

test('golden: a template without new parts exports the same bytes as before', () => {
    const { envelope, warnings } = buildExport(literalTemplate(), {
        exportedAt: '2026-11-11T00:00:00.000Z',
        source: { templateId: 'utpl_0123456789abcdef', orgId: 'org-1', orgName: 'Org', version: 3 },
    });
    const bytes = JSON.stringify(envelope, null, 2);
    const sha = createHash('sha256').update(bytes).digest('hex');
    assert.equal(envelope.schemaVersion, 1);
    assert.deepEqual(Object.keys(envelope.template), ['version', 'title', 'description', 'category', 'icon', 'tags', 'definition', 'dataModel', 'seed', 'datasets']);
    assert.equal(warnings.length, 1);
    assert.equal(sha, GOLDEN_SHA, bytes);
});

const GOLDEN_SHA = '927651d66a8935cf58d264c6ade4ebc826f5af22af193f8eb83456aa30b58ff9';
