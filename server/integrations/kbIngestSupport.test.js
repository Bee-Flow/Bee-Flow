'use strict';

/**
 * The parts of knowledge_base_ingest that need nothing of the write in
 * progress (kbIngestSupport.js): the target-base check and the metadata reader.
 *
 * Run: cd server && node --test integrations/kbIngestSupport.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { KB_INGEST_TOOLS, isKbIngestTool, targetRefusal, readMetadata } = require('./kbIngestSupport');

test('the tool definition names the one tool', () => {
    assert.equal(KB_INGEST_TOOLS.length, 1);
    assert.equal(KB_INGEST_TOOLS[0].function.name, 'knowledge_base_ingest');
    assert.equal(isKbIngestTool('knowledge_base_ingest'), true);
    assert.equal(isKbIngestTool('kb_search'), false);
});

test('targetRefusal: missing, system, another org, no org context; else null', () => {
    assert.deepEqual(targetRefusal(null, 'org1'), { error: 'Knowledge base not found.' });
    assert.deepEqual(targetRefusal({ tenant_id: 'system' }, 'org1'), { error: 'Cannot ingest into a system knowledge base.' });
    assert.deepEqual(targetRefusal({ tenant_id: 't', organization_id: 'org2' }, 'org1'), { error: 'Knowledge base does not belong to this organisation.' });
    assert.deepEqual(targetRefusal({ tenant_id: 't', organization_id: 'org1' }, null), { error: 'No organisation context for ingestion.' });
    assert.equal(targetRefusal({ tenant_id: 't', organization_id: 'org1' }, 'org1'), null);
    assert.equal(targetRefusal({ tenant_id: 't', organization_id: null }, null), null, 'a personal base needs no org');
});

test('readMetadata reads JSON text or an object, and anything else as empty', () => {
    assert.deepEqual(readMetadata({ metadata: '{"article":"x"}' }), { article: 'x' });
    assert.deepEqual(readMetadata({ metadata: { article: 'y' } }), { article: 'y' });
    assert.deepEqual(readMetadata({ metadata: 'not json' }), {});
    assert.deepEqual(readMetadata({ metadata: 'null' }), {});
    assert.deepEqual(readMetadata(null), {});
});
