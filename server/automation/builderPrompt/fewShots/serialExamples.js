// @typecheck
'use strict';
/**
 * The serial full-menu examples (2-5): inspect-then-bind, update-in-place,
 * Gmail reply, Nextcloud file to Talk.
 *
 * Four of the builder agent's few-shot dialogues, assembled by
 * ../fewShotExamples.js (which documents the echo contract every tool
 * result here follows and the order the profiles see them in). A factory
 * rather than a constant: each call returns fresh message objects, so a
 * caller that edits a message cannot change the next conversation's copy.
 */

// Example 2: INSPECT-THEN-BIND. The catalog only shows an input count,
// so the agent inspects gmail_search first to learn the exact `q` param
// and `results` output field — then binds those exactly (no guessing).
function inspectThenBindExample() {
    return [
        { role: 'user', content: 'Every morning search my Gmail for unread invoices and notify me with the list.' },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_i0', type: 'function',
                function: { name: 'builder_inspect_tool', arguments: JSON.stringify({ tool: 'gmail_search' }) },
            }],
        },
        {
            role: 'tool', tool_call_id: 'ex_i0',
            content: JSON.stringify({
                tool: 'gmail_search',
                inputs: { q: { type: 'string', required: true }, maxResults: { type: 'number', required: false } },
                requiredInputs: ['q'],
                shape: 'results: array of { id, from, subject, date, snippet }; total: integer',
                iterableFields: ['results'],
            }),
        },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_i1', type: 'function',
                function: { name: 'builder_propose_trigger', arguments: JSON.stringify({ kind: 'schedule', cron: '0 8 * * *', tz: 'Europe/Amsterdam' }) },
            }],
        },
        { role: 'tool', tool_call_id: 'ex_i1', content: JSON.stringify({ ok: true, trigger: { id: 'trg' } }) },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_i2', type: 'function',
                function: {
                    name: 'builder_add_action',
                    arguments: JSON.stringify({
                        tool: 'gmail_search',
                        inputs: { q: { kind: 'literal', value: 'label:invoices is:unread' } },
                    }),
                },
            }],
        },
        { role: 'tool', tool_call_id: 'ex_i2', content: JSON.stringify({ ok: true, stepId: 's_search' }) },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_i3', type: 'function',
                function: {
                    name: 'builder_add_notification',
                    arguments: JSON.stringify({
                        afterStepId: 's_search',
                        title: 'Unread invoices',
                        body: '{{steps.s_search.output.results}}',
                    }),
                },
            }],
        },
        { role: 'tool', tool_call_id: 'ex_i3', content: JSON.stringify({ ok: true, stepId: 's_notif' }) },
    ];
}

// Example 3: UPDATE-IN-PLACE. Build an ai_step, then EDIT it with
// builder_update_step (keeps the id + wiring) — never delete + re-add.
function updateInPlaceExample() {
    return [
        { role: 'user', content: 'Draft a reply to incoming support emails — then make it use the thinking model and reply in Dutch.' },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_e1', type: 'function',
                function: { name: 'builder_propose_trigger', arguments: JSON.stringify({ kind: 'app_event', appProvider: 'gmail', appEvent: 'mail.new' }) },
            }],
        },
        { role: 'tool', tool_call_id: 'ex_e1', content: JSON.stringify({ ok: true, trigger: { id: 'trg' } }) },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_e2', type: 'function',
                function: {
                    name: 'builder_add_ai_step',
                    arguments: JSON.stringify({
                        prompt: 'Draft a short, friendly reply. Respond with JSON {"replyText":"..."}.',
                        outputSchema: { replyText: 'string' },
                        inputs: { snippet: { kind: 'ref', path: 'trigger.output.snippet' } },
                    }),
                },
            }],
        },
        { role: 'tool', tool_call_id: 'ex_e2', content: JSON.stringify({ ok: true, stepId: 's_ai' }) },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_e3', type: 'function',
                function: {
                    name: 'builder_update_step',
                    arguments: JSON.stringify({
                        stepId: 's_ai',
                        patch: { modelTier: 'thinking', systemPrompt: 'You are a courteous support agent. Always reply in Dutch.' },
                    }),
                },
            }],
        },
        { role: 'tool', tool_call_id: 'ex_e3', content: JSON.stringify({ updated: { id: 's_ai', type: 'ai_step' } }) },
    ];
}

// Example 4: an app_event trigger (Gmail) + reply via ai_step + compose.
// Demonstrates template bindings and replyToMessageId.
function gmailReplyExample() {
    return [
        { role: 'user', content: 'When an email comes from boss@example.com, draft a polite acknowledgement and reply.' },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_u1', type: 'function',
                function: {
                    name: 'builder_propose_trigger',
                    arguments: JSON.stringify({
                        kind: 'app_event',
                        appProvider: 'gmail',
                        appEvent: 'mail.new',
                        filter: { from: 'boss@example.com', excludeFromSelf: true },
                    }),
                },
            }],
        },
        { role: 'tool', tool_call_id: 'ex_u1', content: JSON.stringify({ ok: true, trigger: { id: 'trg' } }) },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_u2', type: 'function',
                function: {
                    name: 'builder_add_ai_step',
                    arguments: JSON.stringify({
                        systemPrompt: 'You are a courteous customer-support assistant. Keep replies warm, concise, and professional.',
                        prompt: 'Draft a polite acknowledgement to this email. Respond with JSON {"replyText":"..."}.',
                        outputSchema: { replyText: 'string' },
                        inputs: {
                            from: { kind: 'ref', path: 'trigger.output.from' },
                            subject: { kind: 'ref', path: 'trigger.output.subject' },
                            snippet: { kind: 'ref', path: 'trigger.output.snippet' },
                        },
                    }),
                },
            }],
        },
        { role: 'tool', tool_call_id: 'ex_u2', content: JSON.stringify({ ok: true, stepId: 's_ai' }) },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_u3', type: 'function',
                function: {
                    name: 'builder_add_action',
                    arguments: JSON.stringify({
                        afterStepId: 's_ai',
                        tool: 'gmail_compose',
                        inputs: {
                            replyToMessageId: { kind: 'ref', path: 'trigger.output.messageId' },
                            body: { kind: 'ref', path: 'steps.s_ai.output.replyText' },
                        },
                    }),
                },
            }],
        },
        { role: 'tool', tool_call_id: 'ex_u3', content: JSON.stringify({ ok: true, stepId: 's_send' }) },
    ];
}

// Example 5 (Nextcloud): file.new (poller-backed) → read the file →
// AI summarise → post to a Talk room. Teaches the NC binding shapes
// (trigger.output.path, nextcloud_read_file.content) and that
// nextcloud_talk_send_message needs a `token` (the Talk room token).
function nextcloudTalkExample() {
    return [
        { role: 'user', content: 'When a PDF lands in my Nextcloud Documents folder, summarise it and post the summary to my Talk room.' },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_n1', type: 'function',
                function: {
                    name: 'builder_propose_trigger',
                    arguments: JSON.stringify({
                        kind: 'app_event',
                        appProvider: 'nextcloud',
                        appEvent: 'file.new',
                        filter: { inFolder: '/Documents/', extension: 'pdf' },
                    }),
                },
            }],
        },
        { role: 'tool', tool_call_id: 'ex_n1', content: JSON.stringify({ ok: true, trigger: { id: 'trg' } }) },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_n2', type: 'function',
                function: {
                    name: 'builder_add_action',
                    arguments: JSON.stringify({
                        tool: 'nextcloud_read_file',
                        inputs: { path: { kind: 'ref', path: 'trigger.output.path' } },
                    }),
                },
            }],
        },
        { role: 'tool', tool_call_id: 'ex_n2', content: JSON.stringify({ ok: true, stepId: 's_read' }) },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_n3', type: 'function',
                function: {
                    name: 'builder_add_ai_step',
                    arguments: JSON.stringify({
                        afterStepId: 's_read',
                        prompt: 'Summarise this document in 3 sentences. Respond with JSON {"summary":"..."}.',
                        outputSchema: { summary: 'string' },
                        inputs: { text: { kind: 'ref', path: 'steps.s_read.output.content' } },
                    }),
                },
            }],
        },
        { role: 'tool', tool_call_id: 'ex_n3', content: JSON.stringify({ ok: true, stepId: 's_ai' }) },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_n4', type: 'function',
                function: {
                    name: 'builder_add_action',
                    arguments: JSON.stringify({
                        afterStepId: 's_ai',
                        tool: 'nextcloud_talk_send_message',
                        inputs: {
                            // `token` is the Talk room token — ask the user for it
                            // (this placeholder must be replaced before activating).
                            token: { kind: 'literal', value: '<your-talk-room-token>' },
                            message: { kind: 'ref', path: 'steps.s_ai.output.summary' },
                        },
                    }),
                },
            }],
        },
        { role: 'tool', tool_call_id: 'ex_n4', content: JSON.stringify({ ok: true, stepId: 's_post' }) },
    ];
}

module.exports = { inspectThenBindExample, updateInPlaceExample, gmailReplyExample, nextcloudTalkExample };
