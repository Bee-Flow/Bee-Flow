'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {installResolveStub}=require('../../testUtils/stubRequire');
const fixture={id:'outside-initial-catalog',versionId:'v42',name:'Security',bodyHtml:'<section data-doc-section="cloud"><h2>Cloud responsibilities</h2><p>{{controls}}</p></section>',settings:{contract:{instructions:'Use verified customer facts',parameters:[{key:'cloud',type:'boolean',required:true,summary:'Uses cloud services'},{key:'controls',type:'text',required:true,instructions:'Verified controls'}],sections:[{id:'cloud',title:'Cloud',condition:{parameter:'cloud',operator:'equals',value:true}}]}}};
const queries=[];
let listResult=[{id:fixture.id}];
const extraDocs={};
const restore=installResolveStub({'../../stores/documentStore':{listTemplates:async(user,options)=>{queries.push({user,options});return listResult;},getDocument:async(id,user)=>user==='owner'?extraDocs[id]||(id===fixture.id?fixture:null):null}});
test.after(restore);
const {execute,inspectBindings}=require('./documentDiscovery');
test('builders search beyond a prompt cap, read instructions and selected content, then pin',async()=>{
    const wrap={userId:'owner',_documents:[],_documentDiscoveryRequired:true};
    await execute('builder_search_documents',{query:'security',offset:50},wrap);
    assert.equal(queries.at(-1).options.offset,50);
    assert.ok(inspectBindings({documentId:fixture.id,values:{}},wrap,'builder').error);
    const read=await execute('builder_read_document',{documentId:fixture.id,sectionId:'cloud'},wrap);
    assert.match(read.bodyHtml,/Cloud responsibilities/);
    assert.equal(read.contract.parameters[1].instructions,'Verified controls');
    const args={documentId:fixture.id,values:{cloud:false}};
    assert.equal(inspectBindings(args,wrap,'builder'),null);
    assert.equal(args.documentVersionId,'v42');
    assert.match(inspectBindings({documentId:fixture.id,values:{cloud:true}},wrap,'builder').error,/controls/);
});
test('app builder uses the same discovery and unauthorized IDs reveal no content',async()=>{
    const wrap={userId:'owner'};
    assert.ok((await execute('app_read_document',{documentId:fixture.id},wrap)).contract);
    assert.equal(inspectBindings({documentId:fixture.id,values:{cloud:{kind:'static',value:false}}},wrap,'app'),null);
    assert.deepEqual(await execute('app_read_document',{documentId:fixture.id},{userId:'outsider'}),{error:'Document not found'});
});
test('builders require condition inputs even when not marked required, and do not skip global inputs', () => {
    const {getContract} = require('./documentContract');
    const doc = { ...fixture, bodyHtml: '{{controls}}' + fixture.bodyHtml,
        settings: { contract: { ...fixture.settings.contract, parameters: fixture.settings.contract.parameters.map(p => p.key === 'cloud' ? {...p,required:false} : p) } } };
    const wrap = { _documentContracts: { [doc.id]: getContract(doc) } };
    assert.match(inspectBindings({documentId:doc.id, values:{controls:'MFA'}},wrap,'builder').error, /cloud/);
    assert.match(inspectBindings({documentId:doc.id, values:{cloud:false}},wrap,'builder').error, /controls/);
    assert.equal(inspectBindings({documentId:doc.id, values:{controls:'MFA'}, sectionOverrides:{cloud:'exclude'}},wrap,'builder'), null);
});

test('an unknown sectionId answers with the section ids, not the whole contract', async () => {
    const out = await execute('builder_read_document',{documentId:fixture.id,sectionId:'nope'},{userId:'owner'});
    assert.equal(out.contract, undefined);
    assert.equal(JSON.stringify(out).includes('Verified controls'), false);
    assert.deepEqual(out.sectionIds, ['cloud']);
    assert.match(out.error, /Section not found/);
});
test('includeBody is capped and says so', async () => {
    extraDocs.big = { ...fixture, id: 'big', bodyHtml: '<p>' + 'x'.repeat(60000) + '</p>' };
    const out = await execute('builder_read_document',{documentId:'big',includeBody:true},{userId:'owner'});
    assert.ok(out.bodyHtml.length <= 20000);
    assert.equal(out.bodyTruncated, true);
    const small = await execute('builder_read_document',{documentId:fixture.id,includeBody:true},{userId:'owner'});
    assert.equal(small.bodyTruncated, undefined);
});
test('app_list_documents is built from an explicit allow-list of fields', async () => {
    const { applyListDocuments } = require('../../appStudio/builderTools/dataTools');
    listResult = [{ id: 'd1', name: 'Quote', docType: 'letter', kind: 'document', versionId: 'v1',
        userId: 'other-user', updatedBy: 'other-user', projectId: 'p1', htmlSize: 9, schemaVersion: 2,
        parameters: [{ key: 'a' }], sections: [{ id: 's', title: 'Full section' }],
        placeholders: [{ key: 'a', kind: 'text' }] }];
    const out = await applyListDocuments({ userId: 'owner' });
    assert.deepEqual(out.documents, [{ documentId: 'd1', name: 'Quote', docType: 'letter', kind: 'document', versionId: 'v1', placeholders: [{ key: 'a', kind: 'text' }] }]);
    listResult = [{ id: fixture.id }];
});
