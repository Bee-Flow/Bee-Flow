'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareDocument, assertFinal, evaluateCondition, normalizeContract, safePath } = require('./documentContract');
const { starters } = require('./documentStarters');
const security = () => starters().find(s => s.id === 'security');
const base = { 'customer.name': 'Example', date: '2026-09-17', summary: 'Reviewed environment' };
test('security customers include and exclude sections without requiring excluded fields', () => {
    const a = prepareDocument(security(), { ...base, remoteAccess:true, cloudServices:true, remoteControls:'VPN + MFA',cloudControls:'Restricted roles' });
    assert.equal(a.valid,true); assert.match(a.bodyHtml,/VPN \+ MFA/);
    const b = prepareDocument(security(), { ...base, remoteAccess:false,cloudServices:false });
    assert.equal(b.valid,true); assert.doesNotMatch(b.bodyHtml,/Remote access|Cloud services/);
});
test('unknown applicability and missing applicable data block final output', () => {
    const fill = prepareDocument(security(),base);
    assert.equal(fill.valid,false); assert.ok(fill.sections.some(s => s.state === 'unresolved'));
    assert.throws(() => assertFinal(fill), e => e.status === 422);
    assert.equal(prepareDocument(security(),{...base,remoteAccess:true,cloudServices:false}).valid,false);
});
test('typed zero and false are present; text is not silently coerced', () => {
    const doc = { bodyHtml:'{{count}} {{enabled}}',settings:{contract:{parameters:[{key:'count',type:'number',required:true},{key:'enabled',type:'boolean',required:true}]}} };
    assert.equal(prepareDocument(doc,{count:0,enabled:false}).valid,true);
    assert.equal(prepareDocument(doc,{count:'0',enabled:'false'}).valid,false);
});
test('groups use three-valued logic and reviewed overrides are explicit', () => {
    const rule = {all:[{parameter:'known',operator:'equals',value:true},{parameter:'unknown',operator:'equals',value:true}]};
    assert.equal(evaluateCondition(rule,{known:false}).state,'excluded');
    assert.equal(evaluateCondition(rule,{known:true}).state,'unresolved');
    assert.equal(prepareDocument(security(),{...base,remoteAccess:false,cloudServices:false},{remote:'include'}).valid,false);
});
test('unsafe paths, duplicate IDs and invalid rules are refused', () => {
    for (const path of ['__proto__.x','a.constructor.x','a..b']) assert.equal(safePath(path),false);
    assert.throws(() => normalizeContract({parameters:[{key:'a',type:'banana'}]}));
    assert.throws(() => normalizeContract({sections:[{id:'x'},{id:'x'}]}));
    assert.throws(() => prepareDocument({bodyHtml:''},JSON.parse('{"__proto__.x":true}')));
});
test('list fields validate and templates keep table loop markers in place', () => {
    const invoice = starters().find(s => s.id === 'invoice');
    const fill = prepareDocument(invoice,{...base,lines:[{description:'Service',amount:0}],total:0});
    assert.equal(fill.valid,true); assert.match(fill.bodyHtml,/<td>Service<\/td>/);
    assert.equal(prepareDocument(invoice,{...base,lines:[{description:'Service',amount:'wrong'}],total:0}).valid,false);
});
test('legacy malformed blocks and list truncation cannot become final output', () => {
    assert.equal(prepareDocument({bodyHtml:'{{#if yes}}Broken'},{yes:true}).valid,false);
    assert.equal(prepareDocument({bodyHtml:'{{#each rows}}{{this}}{{/each}}'},{rows:Array(501).fill('x')}).valid,false);
});
test('condition-only inputs appear in the canonical contract and retain typed validation', () => {
    const { getContract } = require('./documentContract');
    const doc = { bodyHtml:'<section data-doc-section="remote">Remote</section>', settings:{contract:{sections:[{id:'remote',condition:{parameter:'enabled',operator:'equals',value:true}}]}} };
    assert.deepEqual(getContract(doc).parameters[0].conditionForSections,['remote']);
    assert.equal(getContract(doc).parameters[0].type,'boolean');
    assert.equal(prepareDocument(doc,{enabled:'false'}).valid,false);
    assert.equal(prepareDocument(doc,{enabled:false}).valid,true);
    assert.equal(prepareDocument(doc,{}, {remote:'exclude'}).valid,true);
});

test('a presentation document is filled as text: its outline keeps an ampersand, a page escapes it', () => {
    const deck = { docType:'presentation', bodyHtml:'# {{customer.name}}\n\n## One\n- {{note}}' };
    const filled = prepareDocument(deck, { customer:{ name:'Bee & Co' }, note:'<b>' });
    assert.equal(filled.valid, true);
    assert.equal(filled.bodyHtml, '# Bee & Co\n\n## One\n- <b>');
    const page = prepareDocument({ docType:'letter', bodyHtml:'<p>{{customer.name}}</p>' }, { customer:{ name:'Bee & Co' } });
    assert.equal(page.bodyHtml, '<p>Bee &amp; Co</p>');
});
