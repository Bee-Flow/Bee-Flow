// @typecheck
'use strict';

/**
 * normalizePatchField, rule by rule: every (step type, field) it rewrites, with
 * the exact value builder_update_step stores. A patched step has to equal a
 * freshly added one, and the model reads what is stored, so each row pins one
 * outcome. Rules that hand off to a shared add-path sanitiser are checked
 * against that sanitiser with an input it changes, so a missing dispatch shows.
 *
 * Run: node --test automation/builderTools/stepEditing/normalizePatchField.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
// The barrel fills cycleDeps (the agent sanitisers) before any rule reads it.
require('../stepEditing');
const { normalizePatchField } = require('./normalizePatchField');
const stepBuilders = require('../stepBuilders');
const { normalizeAskOnce, normalizeCacheInto } = require('../stepBuilders/outboundSteps');
const { clampDocumentTtl, deckLookFields, slideVisualFields } = require('../stepBuilders/documentSteps');
const { sanitizeCodeLimits } = require('../stepBuilders/dataSteps');
const { sanitizeSwitchCases } = require('../stepBuilders/flowSteps');
const { sanitizeNoteSize } = require('../stepBuilders/noteStep');
const { normalizeApprovalConfig } = require('../approval');
const { normalizeQuery } = require('../../../core/automationRunner/httpQuery');
const { normalizeReadTableStep } = require('../../../core/automationModel/tableOps/readTableSpec');
const { normalizeTableStep } = require('../../../core/automationModel/tableOps/spec');
const { DATA_EXTRACTION_MAX_INSTRUCTIONS_CHARS } = require('../../validate/constants');

const ABSENT = Symbol('undefined');
const twelveIds = ['a', '', 3, 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
const ref = { kind: 'ref', path: 'trigger.output.x' };

/**
 * [type, key, input, exact stored value]; ABSENT means the field is cleared.
 * @type {Array<[string, string, any, any]>}
 */
const EXACT = [
    // label, for every type
    ['wait', 'label', '  Keep  ', '  Keep  '], ['note', 'label', '   ', ABSENT], ['ai_step', 'label', 5, ABSENT],
    ['no_such_type', 'label', '', ABSENT],
    // ai_step
    ['ai_step', 'systemPrompt', '  be brief ', 'be brief'], ['ai_step', 'systemPrompt', '  ', null], ['ai_step', 'systemPrompt', 3, null],
    ['ai_step', 'modelTier', '', 'auto'], ['ai_step', 'modelTier', 'fast', 'fast'],
    ['ai_step', 'allowTools', 1, true], ['ai_step', 'allowTools', 0, false],
    ['ai_step', 'tools', ['a', 1, 'b'], ['a', 'b']], ['ai_step', 'tools', 'a', null],
    ['ai_step', 'outputSchema', 0, null], ['ai_step', 'outputSchema', { a: 1 }, { a: 1 }],
    ['ai_step', 'knowledgeBaseIds', twelveIds, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']], ['ai_step', 'knowledgeBaseIds', 'x', []],
    ['ai_step', 'agentId', ' ag 1 ', 'ag 1'], ['ai_step', 'agentId', 5, null],
    ['ai_step', 'skillIds', ['a', 1, 'a'], ['a']], ['ai_step', 'skillIds', 'x', []],
    ['ai_step', 'agentPermissions', { useTools: true }, { startAutomations: false, useKnowledge: false, useTools: true }],
    ['ai_step', 'disabledAgentSkillIds', ['s', 2], ['s']],
    ['ai_step', 'askOnce', {}, true], ['ai_step', 'askOnce', 'x', ABSENT],
    ['ai_step', 'temperature', null, ABSENT], ['ai_step', 'temperature', 0.3, 0.3], ['ai_step', 'temperature', 'hot', 'hot'],
    ['ai_step', 'enumFrom', [], ABSENT], ['ai_step', 'checks', [], ABSENT], ['ai_step', 'fallback', undefined, ABSENT],
    ['ai_step', 'enumFrom', 'a.b', 'a.b'], ['ai_step', 'temperature', [], []],
    ['ai_step', 'channels', 'x', 'x'], ['ai_step', 'limits', 'x', 'x'],
    // code
    ['code', 'outputSchema', '', null], ['code', 'allowedTools', 'x', []], ['code', 'allowedTools', ['a'], ['a']],
    ['code', 'limits', { timeoutMs: 'x' }, { timeoutMs: 'x' }],
    ['code', 'limits', undefined, { memoryMb: 64, cpuMs: 1000, wallMs: 5000, httpBudget: 5 }],
    ['code', 'tools', 'a', 'a'],
    // notification
    ['notification', 'channels', 'x', ['notification']], ['notification', 'channels', ['email'], ['email']],
    // form_page
    ['form_page', 'mode', 'ending', 'ending'], ['form_page', 'mode', 'x', 'input'],
    ['form_page', 'form', { a: 1 }, { a: 1 }], ['form_page', 'form', [], null], ['form_page', 'form', null, null],
    ['form_page', 'waitSeconds', 10, 60], ['form_page', 'waitSeconds', 1e9, 604800], ['form_page', 'waitSeconds', 'abc', 3600],
    ['form_page', 'waitSeconds', 100.4, 100], ['form_page', 'when', '  a == 1 ', 'a == 1'], ['form_page', 'when', ' ', null],
    // http_request
    ['http_request', 'method', 'post', 'POST'], ['http_request', 'method', '', 'GET'],
    ['http_request', 'headers', [], {}], ['http_request', 'headers', { a: 'b' }, { a: 'b' }],
    ['http_request', 'body', 5, ''], ['http_request', 'body', 'b', 'b'],
    ['http_request', 'timeoutMs', 5, 1000], ['http_request', 'timeoutMs', 1e6, 60000], ['http_request', 'timeoutMs', 'x', 10000],
    ['http_request', 'timeoutMs', 2000.5, 2000.5],
    ['http_request', 'blockPrivateTargets', false, false], ['http_request', 'blockPrivateTargets', 0, true],
    ['http_request', 'parseResponse', 'never', 'never'], ['http_request', 'parseResponse', 'always', 'always'],
    ['http_request', 'parseResponse', 'x', 'auto'],
    ['http_request', 'askOnce', {}, true], ['http_request', 'cacheInto', 'x', ABSENT],
    ['http_request', 'cacheInto', { datatableId: ' t ', maxAgeDays: 2.6 }, { datatableId: 't', maxAgeDays: 3 }],
    // generate_document
    ['generate_document', 'format', 'docx', 'docx'], ['generate_document', 'format', 'x', 'pdf'],
    ['generate_document', 'contentFormat', 'html', 'html'], ['generate_document', 'contentFormat', 'x', 'markdown'],
    ['generate_document', 'expiresInDays', 'abc', 7], ['generate_document', 'expiresInDays', 1000, 90],
    ['generate_document', 'content', 5, ''], ['generate_document', 'title', 5, ''], ['generate_document', 'fileName', 'f', 'f'],
    // slide
    ['slide', 'layout', 'chart', 'chart'], ['slide', 'layout', 'auto', ABSENT],
    ['slide', 'title', 1, ''], ['slide', 'content', 1, ''], ['slide', 'notes', 'n', 'n'],
    ['slide', 'image', ' u ', 'u'], ['slide', 'image', ' ', ABSENT],
    // presentation
    ['presentation', 'format', 'pdf', 'pdf'], ['presentation', 'format', 'x', 'pptx'],
    ['presentation', 'houseStyle', false, false], ['presentation', 'houseStyle', 0, true],
    ['presentation', 'expiresInDays', 'x', 7], ['presentation', 'title', 1, ''], ['presentation', 'subtitle', 1, ''],
    ['presentation', 'fileName', 'f', 'f'],
    ['presentation', 'logo', 'Geen ', 'none'], ['presentation', 'logo', 'OFF', 'none'], ['presentation', 'accent', 'red', ABSENT],
    ['presentation', 'slides', 'x', 'x'], ['presentation', 'slides', [1], [1]], ['presentation', 'slides', ref, '{{trigger.output.x}}'],
    ['presentation', 'slides', {}, ''], ['presentation', 'slides', 5, ''],
    // fill_document
    ['fill_document', 'expiresInDays', 'x', 7], ['fill_document', 'saveCopy', 'true', false], ['fill_document', 'saveCopy', true, true],
    ['fill_document', 'documentId', 5, ''], ['fill_document', 'documentName', 5, ''], ['fill_document', 'fileName', 5, ''],
    ['fill_document', 'copyName', 'c', 'c'], ['fill_document', 'values', [], {}], ['fill_document', 'values', { a: 1 }, { a: 1 }],
    // data_extraction
    ['data_extraction', 'instructions', ' a ', 'a'], ['data_extraction', 'instructions', '  ', ABSENT],
    ['data_extraction', 'instructions', 5, ABSENT], ['data_extraction', 'mode', 'x', 'x'],
    // switch, filter
    ['switch', 'cases', [{ name: 'a', value: '1', x: 2 }], [{ name: 'a', value: '1' }]], ['switch', 'cases', 'x', []],
    ['switch', 'defaultBranch', 5, null], ['switch', 'defaultBranch', 'b', 'b'],
    ['switch', 'matchMode', 'all', 'all'], ['switch', 'matchMode', 'x', ABSENT],
    ['switch', 'arrayRef', ' a ', 'a'], ['switch', 'arrayRef', null, ABSENT],
    ['switch', 'maxItems', 3, 3], ['switch', 'maxItems', 0, ABSENT], ['filter', 'maxItems', 2.5, ABSENT], ['filter', 'maxItems', '3', ABSENT],
    ['filter', 'maxItems', 4, 4], ['filter', 'cases', 'x', 'x'],
    // integration_action
    ['integration_action', 'askOnce', { acrossRuns: true }, { acrossRuns: true }], ['integration_action', 'cacheInto', 'x', 'x'],
    // parse_json
    ['parse_json', 'sourceRef', 5, ''], ['parse_json', 'itemsRef', 'i', 'i'], ['parse_json', 'mode', 'ai', 'ai'], ['parse_json', 'mode', 'x', 'paths'],
    // set
    ['set', 'arrayRef', ' a ', 'a'], ['set', 'arrayRef', 5, ABSENT], ['set', 'maxItems', 2, 2], ['set', 'maxItems', '2', ABSENT],
    // loop, wait
    ['loop', 'maxIterations', 0, 100], ['loop', 'maxIterations', 5, 5],
    ['wait', 'seconds', 0, 1], ['wait', 'seconds', 1e6, 86400], ['wait', 'seconds', 'x', 1], ['wait', 'seconds', 2.5, 2.5],
    // approval
    ['approval', 'approval', { assignee: 'x' }, { expiresInHours: 168 }], ['approval', 'mode', 'x', 'x'],
    // limit
    ['limit', 'count', -3, 0], ['limit', 'count', 2.7, 2], ['limit', 'count', 'x', 0], ['limit', 'mode', 'last', 'last'], ['limit', 'mode', 'x', 'first'],
    // datatable
    ['datatable', 'datatableId', ' a ', 'a'], ['datatable', 'datatableKey', 5, ABSENT], ['datatable', 'operation', 'x', 'x'],
    // knowledge_write
    ['knowledge_write', 'content', ref, '{{trigger.output.x}}'], ['knowledge_write', 'title', 't', 't'], ['knowledge_write', 'sourceUri', ref, '{{trigger.output.x}}'],
    ['knowledge_write', 'knowledgeBaseId', ' k ', 'k'], ['knowledge_write', 'knowledgeBaseId', 5, ABSENT],
    ['knowledge_write', 'nearDuplicateStrategy', 'skip', ABSENT], ['knowledge_write', 'nearDuplicateStrategy', 'merge', 'merge'],
    ['knowledge_write', 'nearDuplicateStrategy', 'x', ABSENT],
    // table
    ['table', 'name', ' n ', 'n'], ['table', 'name', ' ', ABSENT], ['table', 'expiresInDays', 9999, 90], ['table', 'expiresInDays', 'x', 7],
    ['table', 'columns', 'x', 'x'],
    // guard, tokenize, untokenize
    ['guard', 'sourceRef', ' a ', 'a'], ['tokenize', 'sourceRef', 5, ''], ['untokenize', 'sourceRef', 'u', 'u'],
    ['guard', 'categories', ['a', '', 2], ['a']], ['tokenize', 'categories', [], ABSENT], ['untokenize', 'categories', 'x', ABSENT],
    ['guard', 'confidence', 0.5, 0.5], ['guard', 'confidence', 0, ABSENT], ['tokenize', 'confidence', 1.5, ABSENT], ['untokenize', 'confidence', 1, 1],
    ['guard', 'confidence', '0.5', ABSENT],
    ['guard', 'onFound', { stop: true, mask: 1, tokenize: true, x: 1 }, { stop: true, tokenize: true }], ['tokenize', 'onFound', { mask: true }, { mask: true }],
    ['guard', 'onFound', {}, ABSENT], ['untokenize', 'onFound', [], ABSENT],
    // dedupe, flatten
    ['dedupe', 'keyField', 'a', 'a'], ['dedupe', 'keyField', 5, ABSENT],
    ['flatten', 'keepEmpty', true, true], ['flatten', 'keepEmpty', 1, ABSENT], ['flatten', 'maxItems', 3, 3], ['flatten', 'maxItems', -1, ABSENT],
    // note
    ['note', 'text', 'x'.repeat(5000), 'x'.repeat(require('../stepBuilders/noteStep').NOTE_MAX_TEXT_LENGTH)], ['note', 'text', 5, ''],
    ['note', 'position', { x: '1', y: 2 }, { x: 1, y: 2 }], ['note', 'position', { x: 'a', y: 2 }, ABSENT], ['note', 'position', null, ABSENT],
    ['note', 'size', { width: 100000, height: 5 }, { width: 2000, height: 40 }],
    ['note', 'color', 'amber', 'amber'], ['note', 'color', 'yellow', ABSENT],
    // datetime
    ...['input', 'input2', 'format', 'part', 'unit', 'target', 'timezone', 'epochUnit'].flatMap((k) => /** @type {Array<[string, string, any, any]>} */ ([
        ['datetime', k, 's', 's'], ['datetime', k, 5, ABSENT],
    ])),
    ['datetime', 'arrayRef', '', ''], ['datetime', 'arrayRef', null, ABSENT],
    ['datetime', 'amount', 3, 3], ['datetime', 'amount', '3', ABSENT], ['datetime', 'mode', 7, 7],
    // anything without a rule is stored as given
    ['no_such_type', 'mode', { a: 1 }, { a: 1 }], ['wait', 'channels', 'x', 'x'], ['loop', 'constructor', 'c', 'c'],
    ['note', 'toString', 's', 's'], ['__proto__', 'mode', 'm', 'm'],
];

test('normalizePatchField stores the exact value per step type and field', () => {
    for (const [type, key, input, expected] of EXACT) {
        const got = normalizePatchField(type, key, input);
        const want = expected === ABSENT ? undefined : expected;
        assert.deepStrictEqual(got, want, `${type}.${key} ${String(JSON.stringify(input))}`);
    }
});

/**
 * [type, key, input, the add path's own sanitiser]. Each input is one the
 * sanitiser changes, so a field that skips its rule fails here.
 * @type {Array<[string, string, any, (value: any) => any]>}
 */
const VIA_ADD_PATH = [
    ['ai_step', 'agentPermissions', null, v => stepBuilders.sanitizeAgentPermissions(v)],
    ['ai_step', 'askOnce', { key: 'x' }, normalizeAskOnce],
    ['code', 'limits', undefined, v => sanitizeCodeLimits(v).limits],
    ['http_request', 'query', { a: 1 }, normalizeQuery],
    ['http_request', 'cacheInto', { datatableKey: 't' }, normalizeCacheInto],
    ['generate_document', 'expiresInDays', 1000, clampDocumentTtl],
    ['presentation', 'expiresInDays', 1000, clampDocumentTtl],
    ['fill_document', 'expiresInDays', 1000, clampDocumentTtl],
    ['slide', 'chart', { type: 'bar' }, v => slideVisualFields({ chart: v }).chart],
    ['slide', 'stats', [], v => slideVisualFields({ stats: v }).stats],
    ['slide', 'style', 'x', v => slideVisualFields({ style: v }).style],
    ...['preset', 'accent', 'background', 'font', 'titleFont', 'coverStyle', 'tableStyle', 'logoPlacement', 'footerText', 'template']
        .map((k) => /** @type {[string, string, any, (value: any) => any]} */ (['presentation', k, 12345, (v) => deckLookFields({ [k]: v })[k]])),
    ['presentation', 'logo', 12345, v => deckLookFields({ logo: v }).logo],
    ['presentation', 'slideNumbers', 'x', v => deckLookFields({ slideNumbers: v }).slideNumbers],
    ['switch', 'cases', [{ name: 'a', value: '1', x: 2 }], sanitizeSwitchCases],
    ['approval', 'approval', { assignee: 'x' }, normalizeApprovalConfig],
    ['read_table', 'headerRow', 999, v => normalizeReadTableStep({ headerRow: v }).headerRow],
    ['read_table', 'format', 'nope', v => normalizeReadTableStep({ format: v }).format],
    ['read_table', 'anyField', 1, v => normalizeReadTableStep({ anyField: v }).anyField],
    ['table', 'expiresInDays', 9999, v => normalizeTableStep({ expiresInDays: v }).expiresInDays],
    ['note', 'size', 'x', sanitizeNoteSize],
];

test('fields with a shared add-path sanitiser go through it', () => {
    for (const [type, key, input, sanitise] of VIA_ADD_PATH) {
        const want = sanitise(input);
        assert.notDeepStrictEqual(want, input, `${type}.${key}: pick an input the sanitiser changes`);
        assert.deepStrictEqual(normalizePatchField(type, key, input), want, `${type}.${key} ${JSON.stringify(input)}`);
    }
});

test('data_extraction instructions are capped at the validator limit', () => {
    const long = 'y'.repeat(DATA_EXTRACTION_MAX_INSTRUCTIONS_CHARS + 50);
    assert.strictEqual(normalizePatchField('data_extraction', 'instructions', long).length, DATA_EXTRACTION_MAX_INSTRUCTIONS_CHARS);
});
