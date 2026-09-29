'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../testUtils/stubRequire');
const { starters } = require('../core/documents/documentStarters');
const { prepareDocument, assertFinal } = require('../core/documents/documentContract');

const doc = { ...starters().find(s => s.id === 'security'), id:'security', userId:'owner', versionId:'v1', kind:'document' };
// A presentation beside the page: its body is an outline, its look settings.deck.
const deck = { id:'deck', userId:'owner', versionId:'v1', kind:'document', docType:'presentation', name:'Kick-off',
    bodyHtml:'# Kick-off {{customer.name}}\n\n## Goals\n- a\n- b\n\n## Thanks\n<!-- layout: closing -->\nSee you', css:'', settings:{ deck:{ preset:'dark' }, sampleValues:{ customer:{ name:'ACME' } } } };
const byId = { [doc.id]: doc, [deck.id]: deck };
let renderCalls = [];
let rendererUnavailable = false;
let requestedVersion;
const restore = installResolveStub({
    '../auth/permissions': {
        requireAuth:(req,res,next)=>req.session?.user ? next() : res.status(401).json({error:'Not authenticated'}),
        requirePermission:()=> (_req,_res,next)=>next(), hasPermission:async()=>false,
    },
    '../stores/documentStore': {
        MAX_HTML_BYTES: 512 * 1024,
        getDocument:async(id,user)=>byId[id] && user === byId[id].userId ? structuredClone(byId[id]) : null,
        getDocumentVersion:async(id,user,version)=>{requestedVersion=version;return byId[id] && user===byId[id].userId && version==='v1'?structuredClone(byId[id]):null;},
    },
    // The route's own house-style calls are not exercised here; the deck
    // renderer (same require string, from services/) needs the neutral theme.
    '../core/documents/documentHouseStyle': { deckThemeFor: async (_org, { overrides } = {}) => require('../core/documents/deckThemeOptions').resolveDeckTheme(null, null, require('../core/documents/deckThemeOptions').normaliseDeckOverrides(overrides)) },
    '../core/documents/renderFilledDocument': {
        houseStyleCssFor:async()=>'',
        renderFilledDocument:async({document,values,sectionOverrides,format})=>{
            renderCalls.push({ id: document.id, format });
            const fill=prepareDocument(document,values,sectionOverrides);assertFinal(fill);
            if(rendererUnavailable)throw Object.assign(new Error('Styled PDF rendering is unavailable. Please retry.'),{status:503,errorClass:'document_renderer_unavailable'});
            if (document.docType === 'presentation' && format !== 'pdf') return {buffer:Buffer.from('PK-'+fill.bodyHtml),contentType:'application/vnd.openxmlformats-officedocument.presentationml.presentation',extension:'pptx'};
            return {buffer:Buffer.from('%PDF-'+fill.bodyHtml),contentType:'application/pdf',extension:'pdf'};
        },
    },
    // The deck viewer is rendered by the real deck engine (no org → the
    // neutral theme); the browser is absent, which the html format never needs.
    './browserProvider': { withContext: async () => { throw new Error('no browser in this test'); } },
    '../../stores/configStore': { getConfig: async () => null, setConfig: async () => {} },
    '../compliance/marking': {resolveMarking:async()=>null},
});
test.after(restore);
const router = require('./studioDocuments');
function dispatch(method,url,{body={},query={},user='owner'}={}) {
    return new Promise((resolve,reject)=>{
        const req={method,url,body,query,headers:{},session:user?{user:{id:user}}:null};
        const res={statusCode:200,headers:{},status(code){this.statusCode=code;return this;},set(k,v){this.headers[k]=v;return this;},json(data){this.body=data;resolve(this);return this;},send(data){this.body=data;resolve(this);return this;}};
        router(req,res,e=>reject(e || new Error('Route not found')));
    });
}
const base={'customer.name':'Customer',date:'2026-09-17',summary:'Verified facts'};
test('preview explains applicable and excluded sections for two customers',async()=>{
    const a=await dispatch('POST','/security/validate',{body:{values:{...base,remoteAccess:true,cloudServices:true,remoteControls:'VPN and MFA',cloudControls:'Restricted roles'}}});
    assert.equal(a.body.valid,true);assert.match(a.body.html,/VPN and MFA/);
    const b=await dispatch('POST','/security/validate',{body:{values:{...base,remoteAccess:false,cloudServices:false}}});
    assert.equal(b.body.valid,true);assert.doesNotMatch(b.body.html,/Remote access|Cloud services/);
    assert.equal(b.body.sections.find(s=>s.id==='cloud').state,'excluded');
    assert.ok(b.body.sections.find(s=>s.id==='cloud').reason);
});
test('final PDFs preserve validation and rendering error statuses',async()=>{
    doc.settings.sampleValues=base;
    let res=await dispatch('GET','/security/pdf');
    assert.equal(res.statusCode,422);assert.ok(res.body.issues.some(i=>i.code==='section_unresolved'));
    doc.settings.sampleValues={...base,remoteAccess:false,cloudServices:false};rendererUnavailable=true;
    res=await dispatch('GET','/security/pdf');
    assert.equal(res.statusCode,503);assert.equal(res.body.code,'document_renderer_unavailable');rendererUnavailable=false;
});
test('export uses the saved revision and private content remains inaccessible',async()=>{
    doc.settings.sampleValues={...base,remoteAccess:false,cloudServices:false};
    const res=await dispatch('GET','/security/pdf',{query:{versionId:'v1'}});
    assert.equal(res.statusCode,200);assert.equal(requestedVersion,'v1');assert.equal(res.headers['Content-Type'],'application/pdf');
    assert.equal((await dispatch('GET','/security/pdf',{user:'outsider'})).statusCode,404);
    assert.equal((await dispatch('POST','/security/validate',{user:null})).statusCode,401);
});
test('unversioned writes cannot bypass conflict detection',async()=>{
    const result=await dispatch('PATCH','/security',{body:{bodyHtml:'Overwrite'}});
    assert.equal(result.statusCode,428);assert.equal(result.body.code,'document_revision_required');
});

test('a presentation previews as the slide viewer, and a draft (outline + look) previews without being saved',async()=>{
    const saved=await dispatch('GET','/deck/preview');
    assert.equal(saved.statusCode,200);assert.match(saved.headers['Content-Type'],/text\/html/);
    assert.match(saved.headers['Content-Security-Policy'],/script-src 'unsafe-inline'/);
    assert.match(saved.body,/class="deck-frame"/);assert.match(saved.body,/Kick-off \{\{customer\.name\}\}/,'the outline as written, tokens and all');
    assert.equal((saved.body.match(/class="deck-frame"/g) || []).length,3);
    const draft=await dispatch('POST','/deck/preview',{body:{bodyHtml:'# Other\n\n## X\n- 1\n\n## Y\n- 2\n\n## Z\n- 3',settings:{deck:{preset:'band'}}}});
    assert.equal(draft.statusCode,200);assert.match(draft.body,/Other/);assert.equal((draft.body.match(/class="deck-frame"/g) || []).length,4);
    assert.equal(byId.deck.bodyHtml.startsWith('# Kick-off'),true,'nothing was stored');
    const empty=await dispatch('POST','/deck/preview',{body:{bodyHtml:'   '}});
    assert.equal(empty.statusCode,200);assert.match(empty.body,/data-deck-empty/);
    assert.equal((await dispatch('POST','/security/preview',{body:{bodyHtml:'x'}})).statusCode,400,'a page has no draft preview');
    assert.equal((await dispatch('GET','/deck/preview',{user:'outsider'})).statusCode,404);
});
test('a presentation downloads as .pptx, and as the PDF deck; a page cannot become a .pptx',async()=>{
    renderCalls=[];
    const pptx=await dispatch('GET','/deck/pptx');
    assert.equal(pptx.statusCode,200);assert.match(pptx.headers['Content-Type'],/presentationml/);
    assert.equal(pptx.headers['Content-Disposition'],'attachment; filename="Kick-off.pptx"');
    assert.deepEqual(renderCalls,[{id:'deck',format:'pptx'}]);
    const pdf=await dispatch('GET','/deck/pdf');
    assert.equal(pdf.statusCode,200);assert.equal(pdf.headers['Content-Type'],'application/pdf');
    assert.deepEqual(renderCalls[1],{id:'deck',format:'pdf'});
    assert.equal((await dispatch('GET','/security/pptx')).statusCode,400);
    assert.equal((await dispatch('GET','/deck/pptx',{user:'outsider'})).statusCode,404);
});
test('the customer preview of a presentation fills the outline into the viewer',async()=>{
    const res=await dispatch('POST','/deck/validate',{body:{values:{customer:{name:'Van Dijk'}}}});
    assert.equal(res.statusCode,200);assert.equal(res.body.valid,true);
    assert.match(res.body.html,/Kick-off Van Dijk/);assert.match(res.body.html,/class="deck-frame"/);
});
