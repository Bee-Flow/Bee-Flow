'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');

test('auto-KB ingest hands the file name over as sourceUri', async () => {
    const router = require('./templates');
    const templateStore = require('../stores/templateStore');
    const kbStore = require('../stores/knowledgeBases');
    const configStore = require('../stores/configStore');
    const localIngest = require('../core/kb/localKBIngest');
    const saved = {
        gt: templateStore.getTemplate, ut: templateStore.updateTemplate,
        ckb: kbStore.createKB, cd: kbStore.createDocument, uc: kbStore.updateChunkCount, bump: kbStore.bumpKBVersion,
        cfg: configStore.getConfig, ing: localIngest.ingestLocally,
    };
    let options = null;
    templateStore.getTemplate = async () => ({ name: 'T', knowledgeBaseIds: [] });
    templateStore.updateTemplate = async () => ({});
    kbStore.createKB = async () => ({ id: 'kb1' });
    kbStore.createDocument = async () => ({ id: 'd1' });
    kbStore.updateChunkCount = async () => {};
    kbStore.bumpKBVersion = async () => {};
    configStore.getConfig = async () => true; // use_azure_doc_processing: local ingest
    localIngest.ingestLocally = async (_u, _k, _d, _t, opts) => { options = opts; return { chunks_created: 1 }; };
    try {
        await router._test_autoCreateTemplateKB('t1', 'u1', 'brief.docx', 'some text');
        assert.strictEqual(options.sourceUri, 'brief.docx');
        assert.strictEqual(options.source_uri, undefined);
    } finally {
        templateStore.getTemplate = saved.gt; templateStore.updateTemplate = saved.ut;
        kbStore.createKB = saved.ckb; kbStore.createDocument = saved.cd;
        kbStore.updateChunkCount = saved.uc; kbStore.bumpKBVersion = saved.bump;
        configStore.getConfig = saved.cfg; localIngest.ingestLocally = saved.ing;
    }
});
