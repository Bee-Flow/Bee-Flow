'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../testUtils/stubRequire');
const restore = installResolveStub({ '../../stores/documentStore': { _test:{assertWithinCaps:()=>{}} } });
test.after(restore);
const { parseProposal } = require('./documentAssistant');
const doc = {versionId:'reviewed',bodyHtml:'<section data-doc-section="cloud">{{customer}}</section>',css:'h1{}',settings:{contract:{parameters:[{key:'customer',type:'text'}],sections:[{id:'cloud'}]}}};

test('design proposals cannot alter content, parameters or conditions', () => {
    const proposal = parseProposal(doc,{explanation:'New design',bodyHtml:'Overwritten',contract:{parameters:[],sections:[]},css:'h1{color:blue}',design:{font:'serif'}},'design');
    assert.equal(proposal.patch.bodyHtml,undefined);
    assert.deepEqual(proposal.patch.settings.contract,doc.settings.contract);
    assert.equal(proposal.expectedVersionId,'reviewed');
    assert.equal(doc.css,'h1{}');
});
test('applicability suggestions never mutate the approved rules or override values', () => {
    const proposal = parseProposal(doc,{explanation:'Cloud applies',bodyHtml:'Replace',design:{},suggestions:[{sectionId:'cloud',choice:'include',reason:'Customer uses cloud'},{sectionId:'unknown',choice:'exclude'}]},'applicability');
    assert.deepEqual(proposal.patch,{});
    assert.equal(proposal.suggestions.length,1);
    assert.equal(doc.settings.sectionOverrides,undefined);
});
test('a presentation proposal: the outline is the body, the look lands on settings.deck (validated), css is ignored', () => {
    const deck = {versionId:'v1',docType:'presentation',bodyHtml:'# T\n\n## One\n- a',css:'',settings:{deck:{preset:'band'}}};
    const look = parseProposal(deck,{explanation:'Darker',bodyHtml:'# Other',css:'h1{}',design:{preset:'dark',accent:'#0489D2',bogus:'x',coverStyle:'nope'}},'design');
    assert.equal(look.patch.bodyHtml,undefined);
    assert.equal(look.patch.css,undefined,'a presentation has no stylesheet');
    assert.deepEqual(look.patch.settings.deck,{preset:'dark',accent:'#0489D2'});
    assert.equal(look.validation.valid,true);
    const content = parseProposal(deck,{explanation:'More slides',bodyHtml:'# T\n\n## One\n- a\n\n## Two\n- b'},'content');
    assert.match(content.patch.bodyHtml,/## Two/);
    assert.deepEqual(content.patch.settings.deck,{preset:'band'},'the look stays when the proposal does not touch it');
});
