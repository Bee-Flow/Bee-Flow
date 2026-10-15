'use strict';

// Characterisation of validateStep's refusals, driven through the exported
// validateAction ({ kind: 'sequence' }). Security-relevant: these are the
// publish-gate refusals (send_email in a loop, ReDoS patterns, approval
// ambiguity, server-only field smuggling). Expectations were captured from the
// code BEFORE any refactor; a change here is a behaviour change.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateAction } = require('./actions');
const { LIMITS } = require('../componentSpecs');

function run(steps, over = {}) {
    const errors = [];
    const warnings = [];
    const ctx = {
        pushE: (r) => errors.push(r),
        pushW: (r) => warnings.push(r),
        screenIds: new Set(['scr_a']),
        ownedAutomations: undefined,
        dataTables: new Map([['tbl_a', new Set(['name', 'doc'])]]),
        dataMailboxConnectors: new Set(['conn_mail']),
        ownedDocuments: new Map([['doc_1', { id: 'doc_1', name: 'Invoice' }]]),
        aiBrowsingEnabled: false,
        ...over,
    };
    validateAction('act_1', { kind: 'sequence', steps }, 'actions.act_1', ctx);
    const fmt = (s) => (r) => `${s} ${r.code} @${r.path}`;
    return [...errors.map(fmt('E')), ...warnings.map(fmt('W'))];
}

const P = 'actions.act_1.steps';
const loopOf = (...inner) => ({ kind: 'loop', source: { kind: 'static', value: [] }, steps: inner });
const att = (k, extra = {}) => ({ kind: k, ...extra });
const st = (value) => ({ kind: 'static', value });
const mail = (extra = {}) => ({ kind: 'send_email', connectorId: 'conn_mail', to: st('a@b.c'), subject: st('s'), body: st('b'), replyToThreadKey: st('t'), ...extra });
const gf = (extra = {}) => att('generate_file', { rows: st([]), fileName: st('f.csv'), resultVar: 'f', ...extra });
const fd = (extra = {}) => att('fill_document', { documentId: 'doc_1', resultVar: 'd', ...extra });
const gp = (extra = {}) => att('generate_presentation', { slides: st('# t'), resultVar: 'p', ...extra });
const fi = (extra = {}) => att('file_intake', { connectorId: 'conn_mail', threadKey: st('t'), resultVar: 'i', ...extra });
const dq = (extra = {}) => att('dataset_query', { dataset: st('ds_1'), resultVar: 'q', ...extra });

const CASES = [
    ['not an object', ['x'], {}, [`E action.step_not_object @${P}[0]`]],
    ['unknown kind', [{ kind: 'send_emial' }], {}, [`E action.step_kind_invalid @${P}[0].kind`]],
    ['unknown field', [{ kind: 'toast', message: 'hi', bogus: 1 }], {}, [`E action.step_unknown_field @${P}[0].bogus`]],
    ['client step carrying a data-mutation field', [{ kind: 'toast', message: 'hi', tableId: 'tbl_a' }], {}, [`E action.step_partition @${P}[0].tableId`]],
    ['too many steps (reported once)', Array.from({ length: LIMITS.MAX_ACTION_STEPS + 3 }, () => ({ kind: 'toast', message: 'x' })), {}, [`E action.too_many_steps @${P}[60]`]],
    ['nesting too deep', [(function nest(d) { return d === 0 ? { kind: 'toast', message: 'x' } : { kind: 'condition', expr: 'true', then: [nest(d - 1)] }; })(LIMITS.MAX_ACTION_DEPTH + 2)], {}, [`E action.step_too_deep @${P}[0].then[0].then[0].then[0].then[0].then[0].then`]],
    ['send_email in loop', [loopOf(mail())], {}, [`E action.send_email_in_loop @${P}[0].steps`]],
    ['send_email buried in loop condition branch', [loopOf({ kind: 'condition', expr: 'true', then: [], else: [mail()] })], {}, [`E action.send_email_in_loop @${P}[0].steps`]],
    ['send_email buried in loop switch case', [loopOf({ kind: 'switch', expr: 'true', cases: [{ value: 1, steps: [mail()] }], default: [mail()] })], {}, [`E action.send_email_in_loop @${P}[0].steps`]],
    ['send_email outside loop is legal', [mail()], {}, []],
    ['send_email both reply targets', [mail({ replyToRecordId: st('r1') })], {}, [`E action.send_email_reply_ambiguous @${P}[0]`]],
    ['send_email unthreaded warns', [mail({ replyToThreadKey: undefined })], {}, [`W action.send_email_unthreaded @${P}[0]`]],
    ['send_email non-mailbox connector', [mail({ connectorId: 'conn_other' })], {}, [`E action.send_email_connector_invalid @${P}[0].connectorId`]],
    ['send_email non-mailbox connector as warning', [mail({ connectorId: 'conn_other' })], { dataRefsAsWarnings: true }, [`W action.send_email_connector_invalid @${P}[0].connectorId`]],
    ['send_email without a data model checks no connector', [mail({ connectorId: 'conn_other' })], { dataMailboxConnectors: null }, []],
    ['request_approval user and group', [att('request_approval', { prompt: st('ok?'), assigneeUserId: 'u1', assigneeGroupId: 'g1' })], {}, [`E action.approval_assignee_ambiguous @${P}[0]`]],
    ['request_approval stages conflict', [att('request_approval', { prompt: st('ok?'), stages: [{ name: 's' }], assigneeUserId: 'u1', approverUserIds: ['u2'], escalateToGroupId: 'g' })], {}, [`E action.approval_stages_invalid @${P}[0].stages[0].approvers`, `E action.approval_stages_conflict @${P}[0].assigneeUserId`, `E action.approval_stages_conflict @${P}[0].approverUserIds`, `E action.approval_stages_conflict @${P}[0].escalateToGroupId`]],
    ['generate_file half attach', [gf({ attachToRecordId: st('r1') })], {}, [`E action.generate_file_attach_partial @${P}[0]`]],
    ['generate_file unknown attach column', [gf({ attachToRecordId: st('r1'), attachToFieldKey: 'nope' })], {}, [`W action.generate_file_field_unknown @${P}[0].attachToFieldKey`]],
    ['generate_file known attach column', [gf({ attachToRecordId: st('r1'), attachToFieldKey: 'doc' })], {}, []],
    ['generate_file ignored delimiter / sheetName', [gf({ format: 'xlsx', delimiter: ';' }), gf({ sheetName: 'S' })], {}, [`W action.generate_file_field_ignored @${P}[0].delimiter`, `W action.generate_file_field_ignored @${P}[1].sheetName`]],
    ['fill_document unknown document', [fd({ documentId: 'doc_x' })], {}, [`E action.fill_document_unknown @${P}[0].documentId`]],
    ['fill_document no document', [fd({ documentId: undefined })], {}, [`E action.step_field_required @${P}[0].documentId`, `E action.fill_document_missing @${P}[0].documentId`]],
    ['fill_document half attach + unknown column', [fd({ attachToFieldKey: 'nope' })], {}, [`E action.fill_document_attach_partial @${P}[0]`, `W action.fill_document_field_unknown @${P}[0].attachToFieldKey`]],
    ['generate_presentation no slides', [gp({ slides: '  ' })], {}, [`E binding.invalid @${P}[0].slides`, `E action.generate_presentation_missing @${P}[0].slides`]],
    ['generate_presentation half attach + unknown column', [gp({ attachToFieldKey: 'nope' })], {}, [`E action.generate_presentation_attach_partial @${P}[0]`, `W action.generate_presentation_field_unknown @${P}[0].attachToFieldKey`]],
    ['presentation / file / document in loop warn', [loopOf(gp(), gf(), fd())], {}, [`W action.generate_presentation_in_loop @${P}[0].steps`, `W action.generate_file_in_loop @${P}[0].steps`, `W action.fill_document_in_loop @${P}[0].steps`]],
    ['file_intake bad connector', [fi({ connectorId: 'conn_other' })], {}, [`E action.file_intake_connector_invalid @${P}[0].connectorId`]],
    ['file_intake unknown output + no upsert key', [fi({ writeTo: { tableId: 'tbl_a', mapping: { name: 'bogus' } } })], {}, [`E action.file_intake_output_unknown @${P}[0].writeTo.mapping.name`, `E action.file_intake_no_upsert_key @${P}[0].writeTo.mapping`]],
    ['file_intake mapping with base_name is clean', [fi({ writeTo: { tableId: 'tbl_a', mapping: { name: 'base_name' } } })], {}, []],
    ['file_intake invalid regex', [fi({ poPattern: '(' })], {}, [`E action.file_intake_pattern_invalid @${P}[0].poPattern`]],
    ['file_intake nested-quantifier regex (ReDoS)', [fi({ poPattern: '(a+)+' })], {}, [`E action.file_intake_pattern_unsafe @${P}[0].poPattern`]],
    ['file_intake sane regex', [fi({ poPattern: 'PO-\\d+' })], {}, []],
    ['ai_browse not enabled', [att('ai_browse', { task: st('t'), resultVar: 'b' })], {}, [`E browse.not_enabled @${P}[0]`]],
    ['ai_browse enabled', [att('ai_browse', { task: st('t'), resultVar: 'b' })], { aiBrowsingEnabled: true }, []],
    ['dataset_query no selector', [dq()], {}, [`E action.dataset_query_selector @${P}[0]`]],
    ['dataset_query two literal selectors', [dq({ gene: st('BRCA1'), rsid: st('rs1') })], {}, [`E action.dataset_query_selector @${P}[0]`]],
    ['dataset_query literal + formula selector warns', [dq({ gene: st('BRCA1'), region: { kind: 'formula', expr: 'form.r' } })], {}, [`W action.dataset_query_mixed_selector @${P}[0]`]],
    ['dataset_query unknown output + no upsertOn', [dq({ gene: st('G'), writeTo: { tableId: 'tbl_a', mapping: { name: 'bogus' } } })], {}, [`E action.dataset_query_output_unknown @${P}[0].writeTo.mapping.name`, `W action.dataset_query_no_upsert @${P}[0].writeTo`]],
    ['create_record writes unknown column', [att('create_record', { tableId: 'tbl_a', values: { ghost: st(1) } })], {}, [`E step.unknown_field @${P}[0].values.ghost`]],
];

for (const [name, steps, over, expected] of CASES) {
    test(`validateStep: ${name}`, () => {
        const got = run(steps, over);
        assert.deepEqual(got, expected);
    });
}
