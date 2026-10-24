// @typecheck
'use strict';
/**
 * Serial example 6: mail attachment to Google Drive via sourceHandle.
 *
 * One of the builder agent's few-shot dialogues, assembled by
 * ../fewShotExamples.js (which documents the echo contract every tool
 * result here follows and the order the profiles see them in). A factory
 * rather than a constant: each call returns fresh message objects, so a
 * caller that edits a message cannot change the next conversation's copy.
 */

// Example 6: mail attachment → Google Drive via sourceHandle (no base64
// through the AI context). Demonstrates filter.hasAttachment, the
// attachments[] payload, the sourceHandle pattern, and chained
// drive_create_folder for the invoices/year/month/supplier path.
function attachmentToDriveExample() {
    return [
        { role: 'user', content: 'When an invoice email comes in, file the PDF in Google Drive under invoices/year/month/supplier.' },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_v1', type: 'function',
                function: {
                    name: 'builder_propose_trigger',
                    arguments: JSON.stringify({
                        kind: 'app_event',
                        appProvider: 'gmail',
                        appEvent: 'mail.new',
                        filter: { hasAttachment: true },
                    }),
                },
            }],
        },
        { role: 'tool', tool_call_id: 'ex_v1', content: JSON.stringify({ ok: true, trigger: { id: 'trg' } }) },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_v2', type: 'function',
                function: {
                    name: 'builder_add_action',
                    arguments: JSON.stringify({
                        tool: 'gmail_read_attachment',
                        inputs: {
                            messageId: { kind: 'ref', path: 'trigger.output.messageId' },
                            attachmentId: { kind: 'ref', path: 'trigger.output.attachments[0].attachmentId' },
                            filename: { kind: 'ref', path: 'trigger.output.attachments[0].filename' },
                        },
                    }),
                },
            }],
        },
        { role: 'tool', tool_call_id: 'ex_v2', content: JSON.stringify({ ok: true, stepId: 's_read' }) },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_v3', type: 'function',
                function: {
                    name: 'builder_add_ai_step',
                    arguments: JSON.stringify({
                        afterStepId: 's_read',
                        prompt: 'Determine if this text is an invoice. If yes, extract supplier, year (YYYY) and month (MM). Respond with JSON.',
                        outputSchema: { isInvoice: 'boolean', supplier: 'string', year: 'string', month: 'string' },
                        inputs: { text: { kind: 'ref', path: 'steps.s_read.output.content' } },
                    }),
                },
            }],
        },
        { role: 'tool', tool_call_id: 'ex_v3', content: JSON.stringify({ ok: true, stepId: 's_ai' }) },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_v4', type: 'function',
                function: {
                    name: 'builder_add_condition',
                    arguments: JSON.stringify({
                        afterStepId: 's_ai',
                        expr: 'steps.s_ai.output.isInvoice == true',
                    }),
                },
            }],
        },
        { role: 'tool', tool_call_id: 'ex_v4', content: JSON.stringify({ ok: true, stepId: 's_if' }) },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_v5', type: 'function',
                function: {
                    name: 'builder_add_action',
                    arguments: JSON.stringify({
                        afterStepId: 's_if',
                        tool: 'drive_create_folder',
                        inputs: { name: { kind: 'ref', path: 'steps.s_ai.output.year' } },
                    }),
                },
            }],
        },
        { role: 'tool', tool_call_id: 'ex_v5', content: JSON.stringify({ ok: true, stepId: 's_year' }) },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_v6', type: 'function',
                function: {
                    name: 'builder_add_action',
                    arguments: JSON.stringify({
                        afterStepId: 's_year',
                        tool: 'drive_create_folder',
                        inputs: {
                            name: { kind: 'ref', path: 'steps.s_ai.output.month' },
                            parentFolderId: { kind: 'ref', path: 'steps.s_year.output.folderId' },
                        },
                    }),
                },
            }],
        },
        { role: 'tool', tool_call_id: 'ex_v6', content: JSON.stringify({ ok: true, stepId: 's_month' }) },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_v7', type: 'function',
                function: {
                    name: 'builder_add_action',
                    arguments: JSON.stringify({
                        afterStepId: 's_month',
                        tool: 'drive_create_folder',
                        inputs: {
                            name: { kind: 'ref', path: 'steps.s_ai.output.supplier' },
                            parentFolderId: { kind: 'ref', path: 'steps.s_month.output.folderId' },
                        },
                    }),
                },
            }],
        },
        { role: 'tool', tool_call_id: 'ex_v7', content: JSON.stringify({ ok: true, stepId: 's_supp' }) },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'ex_v8', type: 'function',
                function: {
                    name: 'builder_add_action',
                    arguments: JSON.stringify({
                        afterStepId: 's_supp',
                        tool: 'drive_upload_file',
                        inputs: {
                            name: { kind: 'ref', path: 'trigger.output.attachments[0].filename' },
                            parentFolderId: { kind: 'ref', path: 'steps.s_supp.output.folderId' },
                            sourceHandle: { kind: 'ref', path: 'steps.s_read.output.sourceHandle' },
                        },
                    }),
                },
            }],
        },
        { role: 'tool', tool_call_id: 'ex_v8', content: JSON.stringify({ ok: true, stepId: 's_up' }) },
    ];
}

module.exports = { attachmentToDriveExample };
