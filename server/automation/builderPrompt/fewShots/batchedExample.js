// @typecheck
'use strict';
/**
 * Batched protocol example: plan + inspect + trigger + name, one builder_add_steps, summarise + dry-run, finalize.
 *
 * One of the builder agent's few-shot dialogues, assembled by
 * ../fewShotExamples.js (which documents the echo contract every tool
 * result here follows and the order the profiles see them in). A factory
 * rather than a constant: each call returns fresh message objects, so a
 * caller that edits a message cannot change the next conversation's copy.
 */

// Batched protocol example — FIRST for the full toolset so the count-1
// profiles (mid, reasoning) see it: one reply carrying plan + batch-inspect +
// trigger, then ONE builder_add_steps with tempId cross-refs, then
// summarise + dry-run together. The 'core' toolset sees it too (since
// 2026-09-11 CORE_TOOL_NAMES carries builder_add_steps), but LAST — see
// the ordering note at the bottom of this function.
// Reply 1 carries the trigger AND the name (builder_set_metadata) beside
// the plan and the batch inspect: an automation nobody named ships as
// "Untitled automation", and no worked example ever showed the call, so
// the small band never made it. The last reply is builder_finalize plus
// one sentence — the end of a build, shown once.
function batchedExample() {
    return [
        { role: 'user', content: 'Every weekday at 8am, search my Gmail for unread invoices and email me a summary.' },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                {
                    id: 'ex_b1', type: 'function',
                    function: {
                        name: 'builder_set_plan',
                        arguments: JSON.stringify({ todos: [{ text: 'Schedule trigger (weekdays 8:00)' }, { text: 'Add search → summarise → send steps' }, { text: 'Dry-run and finalize' }] }),
                    },
                },
                {
                    id: 'ex_b3', type: 'function',
                    function: {
                        name: 'builder_propose_trigger',
                        arguments: JSON.stringify({ kind: 'schedule', cron: '0 8 * * 1-5', tz: 'Europe/Amsterdam' }),
                    },
                },
                {
                    id: 'ex_b8', type: 'function',
                    function: {
                        name: 'builder_set_metadata',
                        arguments: JSON.stringify({ title: 'Weekday invoice digest', description: 'Every weekday at 08:00 search Gmail for unread invoices and e-mail a summary.' }),
                    },
                },
                {
                    id: 'ex_b2', type: 'function',
                    function: {
                        name: 'builder_inspect_tool',
                        arguments: JSON.stringify({ tools: ['gmail_search', 'gmail_compose'] }),
                    },
                },
            ],
        },
        // The REAL echo — {ok, todos:[{i,text,done}], next}. The old {ok,count}
        // shape here taught the model that set_plan returns nothing readable,
        // which is exactly why it re-derived the plan from the user's message
        // every round (see builderModelProfiles.js).
        { role: 'tool', tool_call_id: 'ex_b1', content: JSON.stringify({ ok: true, todos: [{ i: 0, text: 'Schedule trigger (weekdays 8:00)', done: false }, { i: 1, text: 'Add search → summarise → send steps', done: false }, { i: 2, text: 'Dry-run and finalize', done: false }], next: 'Schedule trigger (weekdays 8:00)' }) },
        // applyTrigger returns the trigger node itself; every mutator on a
        // lean profile adds the structured digest and the wiring line.
        { role: 'tool', tool_call_id: 'ex_b3', content: JSON.stringify({ trigger: { id: 'trg', type: 'trigger', kind: 'schedule', output: {}, schedule: { cron: '0 8 * * 1-5', tz: 'Europe/Amsterdam' } }, _draftSteps: [{ id: 'trg', type: 'trigger', kind: 'schedule' }], _wiring: 'main: (no edges yet)' }) },
        { role: 'tool', tool_call_id: 'ex_b8', content: JSON.stringify({ title: 'Weekday invoice digest', description: 'Every weekday at 08:00 search Gmail for unread invoices and e-mail a summary.', _draftSteps: [{ id: 'trg', type: 'trigger', kind: 'schedule' }], _wiring: 'main: (no edges yet)' }) },
        // The batch inspect form; the `shape` strings are the real
        // describeShape() output for the two curated tools, annotations
        // included (a shortened shape here is a shape the model never sees).
        {
            role: 'tool', tool_call_id: 'ex_b2',
            content: JSON.stringify({
                results: {
                    gmail_search: { tool: 'gmail_search', inputs: { query: { type: 'string', required: true }, maxResults: { type: 'number', required: false } }, requiredInputs: ['query'], shape: 'results: array of { id, from, to, subject, date, snippet }; total: integer (estimated total result count); message: string (only present when results is empty)', source: 'curated', sample: null, iterableFields: ['results'] },
                    gmail_compose: { tool: 'gmail_compose', inputs: { to: { type: 'string', required: true }, subject: { type: 'string', required: true }, body: { type: 'string', required: true } }, requiredInputs: ['to', 'subject', 'body'], shape: 'sent: boolean; messageId: string; threadId: string; to: string; subject: string; message: string', source: 'curated', sample: null },
                },
            }),
        },
        // The ai_step reads the search results through `inputs` (a ref
        // binding), never through a {{template}} inside `prompt`: a brace
        // inside a string value is what the local runtime's tool-call parser
        // chops (core/llm/partialJsonScan.looksGarbled).
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_b4', type: 'function',
                function: {
                    name: 'builder_add_steps',
                    arguments: JSON.stringify({
                        steps: [
                            { tempId: 'search', type: 'integration_action', spec: { tool: 'gmail_search', inputs: { query: { kind: 'literal', value: 'label:Invoices is:unread' }, maxResults: { kind: 'literal', value: 25 } }, label: 'Find unread invoices' } },
                            { tempId: 'sum', type: 'ai_step', spec: { prompt: 'Summarise the emails in `emails` (sender, subject, amount if visible) as a short bulleted digest.', inputs: { emails: { kind: 'ref', path: 'steps.$search.output.results' } }, outputSchema: { digest: 'string' }, label: 'Summarise invoices' } },
                            { tempId: 'send', type: 'integration_action', spec: { tool: 'gmail_compose', inputs: { to: { kind: 'literal', value: 'me@example.com' }, subject: { kind: 'literal', value: 'Invoice digest' }, body: { kind: 'ref', path: 'steps.$sum.output.digest' } }, label: 'Email me the digest' } },
                        ],
                    }),
                },
            }],
        },
        {
            role: 'tool', tool_call_id: 'ex_b4',
            content: JSON.stringify({
                added: [{ tempId: 'search', id: 'a_5e1c2b', type: 'integration_action', tool: 'gmail_search' }, { tempId: 'sum', id: 'ai_9d4f7a', type: 'ai_step' }, { tempId: 'send', id: 'a_3c8e6d', type: 'integration_action', tool: 'gmail_compose' }],
                idMap: { search: 'a_5e1c2b', sum: 'ai_9d4f7a', send: 'a_3c8e6d' },
                _draftSteps: [
                    { id: 'trg', type: 'trigger', kind: 'schedule' },
                    { id: 'a_5e1c2b', type: 'integration_action', tool: 'gmail_search', label: 'Find unread invoices' },
                    { id: 'ai_9d4f7a', type: 'ai_step', label: 'Summarise invoices' },
                    { id: 'a_3c8e6d', type: 'integration_action', tool: 'gmail_compose', label: 'Email me the digest' },
                ],
                _wiring: 'main: trg→a_5e1c2b, a_5e1c2b→ai_9d4f7a, ai_9d4f7a→a_3c8e6d',
            }),
        },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                { id: 'ex_b5', type: 'function', function: { name: 'builder_set_plan', arguments: JSON.stringify({ markDone: [0, 1] }) } },
                { id: 'ex_b6', type: 'function', function: { name: 'builder_summarise', arguments: '{}' } },
                { id: 'ex_b7', type: 'function', function: { name: 'builder_request_dry_run', arguments: '{}' } },
            ],
        },
        { role: 'tool', tool_call_id: 'ex_b5', content: JSON.stringify({ ok: true, todos: [{ i: 0, text: 'Schedule trigger (weekdays 8:00)', done: true }, { i: 1, text: 'Add search → summarise → send steps', done: true }, { i: 2, text: 'Dry-run and finalize', done: false }], next: 'Dry-run and finalize' }) },
        // applySummarise: {summary, hasSideEffects} — no `ok`.
        { role: 'tool', tool_call_id: 'ex_b6', content: JSON.stringify({ summary: '**Trigger:** On schedule (`0 8 * * 1-5`, Europe/Amsterdam).\n\n**Steps:**\n1. Call `gmail_search` with query="label:Invoices is:unread", maxResults=25 — Find unread invoices.\n2. Ask the AI (auto): "Summarise the emails in `emails` (sender, subject, amount if visible) as a short bulleted digest."\n3. **Call `gmail_compose` with to="me@example.com", subject="Invoice digest", body=`steps.ai_9d4f7a.output.digest` — Email me the digest.**', hasSideEffects: true }) },
        // compactDryRunForModel: the read ran live, the AI step ran live, the
        // send was synthesised (a side effect never happens in a dry run) —
        // status 'success' on all three, `_dryRunSynthesised` marks the one
        // that was not real. A synthesised send is the tool's CURATED sample
        // (outputSchemas.js — gmail_compose's sent-email shape, six keys, with
        // its own placeholder recipient and subject, not the step's inputs)
        // stamped `_dryRunSynthesised` / `_dryRunFallback: null` by runDag;
        // the replay test derives this head from those same functions.
        {
            role: 'tool', tool_call_id: 'ex_b7',
            content: JSON.stringify({
                run: { id: 'r1', status: 'success', stepCount: 3 },
                ok: true,
                note: 'Clean run: every step succeeded. Nothing to fix: finish with builder_finalize.',
                steps: [
                    { stepId: 'a_5e1c2b', stepType: 'integration_action', status: 'success', _hint: { outputType: 'object', topKeys: ['results', 'total'], shape: 'results[*]: { id, from, to, subject, date, snippet }; total: integer' } },
                    { stepId: 'ai_9d4f7a', stepType: 'ai_step', status: 'success', _hint: { outputType: 'object', topKeys: ['digest'], shape: 'digest: string' } },
                    { stepId: 'a_3c8e6d', stepType: 'integration_action', status: 'success', _hint: { outputType: 'object', topKeys: ['sent', 'messageId', 'threadId', 'to', 'subject', 'message', '_dryRunSynthesised', '_dryRunFallback'], shape: 'sent: boolean; messageId: string; threadId: string; to: string; subject: string; message: string; _dryRunSynthesised: boolean; _dryRunFallback: null' } },
                ],
            }),
        },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                { id: 'ex_b9', type: 'function', function: { name: 'builder_set_plan', arguments: JSON.stringify({ markDone: [2] }) } },
                { id: 'ex_b10', type: 'function', function: { name: 'builder_finalize', arguments: '{}' } },
            ],
        },
        { role: 'tool', tool_call_id: 'ex_b9', content: JSON.stringify({ ok: true, todos: [{ i: 0, text: 'Schedule trigger (weekdays 8:00)', done: true }, { i: 1, text: 'Add search → summarise → send steps', done: true }, { i: 2, text: 'Dry-run and finalize', done: true }], next: null }) },
        { role: 'tool', tool_call_id: 'ex_b10', content: JSON.stringify({ automation: { id: 'auto_1', title: 'Weekday invoice digest' }, ok: true }) },
        { role: 'assistant', content: 'Done — "Weekday invoice digest" is saved and ready to activate.' },
    ];
}

module.exports = { batchedExample };
