const test = require('node:test');
const assert = require('node:assert/strict');
const { answerShared } = require('./coworkSharedConversation');

const item = {id:'shared-task', title:'Shared agenda',prompt:'Digest', userId:'owner-secret', secret:'INTERNAL_ONLY'};
const view = {item, runs:[
    {id:'run-1',status:'success', startedAt:'2026-11-25', result:'OUTCOME_LATEST', token:'RUN_SECRET'},
    {id:'run-2',status:'success', startedAt:'2026-11-24', result:'OUTCOME_PRIOR'},
]};
const turn = {view:'shared', message:'What was the action?', history:[]};

test('a viewer asks about one shared run: only its excerpt reaches the model, charged to the reader', async () => {
    const replies = [{action:'read_result', answer:'Looking', runIndex:1}, {action:'answer', answer:'Prior result discussed.'}];
    const calls = [], spend = [];
    const deps = {model: async req => {calls.push(req); return JSON.stringify(replies.shift());}, spend: async item => spend.push(item)};
    const reply = await answerShared(view, {userId:'reader',userOrgId:'reader-org'}, turn, undefined, deps);
    assert.deepEqual(reply,{action:'answer',answer:'Prior result discussed.',instruction:''});
    assert.deepEqual(spend,[{id:item.id,userId:'reader'}]);
    assert.equal(calls.length,2);
    for (const call of calls) {
        assert.equal(call.userId,'reader');
        assert.equal(call.userOrgId,'reader-org');
        assert.doesNotMatch(JSON.stringify(call), /owner-secret|INTERNAL_ONLY|RUN_SECRET|OUTCOME_LATEST/);
    }
    assert.doesNotMatch(JSON.stringify(calls[0]),/OUTCOME_PRIOR/);
    assert.match(JSON.stringify(calls[1]),/OUTCOME_PRIOR/);
});

test('shared task discovery searches only work accessible to the reader', async () => {
    const deps = {model:async () => JSON.stringify({action:'switch_task',answer:'Looking',query:'Stock'}),
        tasks:async reader => {assert.equal(reader,'viewer'); return [{id:'stock',title:'Stock',ownerName:'Other'}];}};
    const result = await answerShared(view,{userId:'viewer',userOrgId:'org'},turn,undefined,deps);
    assert.equal(result.switchTo,'stock');
    assert.equal(result.tasks[0].shared,true);
});

test('an unsupported or mutating action from a shared conversation never opens owner controls', async () => {
    const received = [];
    const stream = {signal:new AbortController().signal, onText:raw => received.push(raw)};
    const invalid = JSON.stringify({action:'change', instruction:'Remove steps',answer:'I deleted everything.'});
    const reply = await answerShared(view,{userId:'reader'},turn,stream,{model:async args => {
        args.stream.onText(invalid);
        return invalid;
    }});
    assert.deepEqual(received, []);
    assert.deepEqual(reply,{action:'answer',ownerOnly:true,answer:'Only the owner can change this shared task.',instruction:''});
});

test('opens the reader’s own settings or imports with a valid section, without granting rights on a shared task', async () => {
    for (const [action, section, expected] of [['preferences', 'mail', 'mail'], ['templates', 'import', 'import'], ['org', 'budget', 'budget'], ['org', 'delete', undefined]]) {
        const deps = {model: async () => JSON.stringify({action, section, answer: 'Here it is.'})};
        const reply = await answerShared(view, {userId:'reader'}, turn, undefined, deps);
        assert.equal(reply.action, action);
        assert.equal(reply.section, expected);
    }
});
