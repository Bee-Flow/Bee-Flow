/**
 * DIFFERENTIAL lockstep: the one-line card summaries and the display helpers
 * behind them, against the web's nodeSummaries.js and displayHelpers.js, over
 * every step of every fixture and template plus a matrix of hand-made steps.
 */

import fs from 'node:fs';
import path from 'node:path';

import * as display from './displayHelpers';
import * as summaries from './nodeSummaries';
import { FIXTURES, templateDefinitions } from './testing/fixtures';
import type { FlowDefinition } from './types';

const FLOW = '../../../../../agent-hub/src/components/automation/Builder/flow';
/* eslint-disable @typescript-eslint/no-require-imports */
const webSummaries = require(`${FLOW}/nodeSummaries.js`);
const webDisplay = require(`${FLOW}/displayHelpers.js`);
const TEMPLATES_JS = path.resolve(__dirname, '../../../../../server/automation/templates.js');
const TEMPLATES = templateDefinitions(fs.readFileSync(TEMPLATES_JS, 'utf8'), require(TEMPLATES_JS).getTemplate);
/* eslint-enable @typescript-eslint/no-require-imports */

const DEFS: FlowDefinition[] = [...Object.values(FIXTURES), ...Object.values(TEMPLATES)];
const LABELS = new Map([['s1', 'Search email'], ['ai_a9afb3', 'Classify']]);

const MATRIX: Record<string, unknown>[] = [
    {}, { arrayRef: 'steps.s1.output.results' }, { arrayRef: 'steps.zz.output' }, { arrayRef: 'trigger.output.items', count: 3 },
    { arrayRef: 'loop.item.rows', count: 0 }, { arrayRef: 'x', count: 'a', mode: 'last' }, { arrayRef: 'x', count: 2, mode: 'last' },
    { arrayRef: 'x', keyField: 'from_email' }, { arrayRef: 'x', field: 'amount' }, { arrayRef: 'x', op: 'count' },
    { arrayRef: 'x', op: 'avg' }, { arrayRef: 'x', op: 'avg', field: 'total' }, { arrayRef: 'x', op: 'median', field: 'total' },
    { datatableId: 't1' }, { datatableId: 't1', op: 'save_row' }, { datatableId: 't1', op: 'save_row', matchColumn: 'id' },
    { datatableId: 't1', op: 'update_rows' }, { datatableId: 't1', op: 'delete_rows', where: [{ field: 'customer_id' }, null, {}] },
    { datatableId: 't1', op: 'bogus' }, { datatableId: 'gone' },
    { knowledgeBaseId: 'k1' }, { knowledgeBaseId: 'k1', content: '  ' }, { knowledgeBaseId: 'k1', content: 'x' }, { knowledgeBaseId: 'kx', content: 'x' },
    { op: 'now' }, { op: 'parse' }, { op: 'format' }, { op: 'format', format: 'YYYY' }, { op: 'diff' }, { op: 'diff', unit: 'days' },
    { op: 'extract' }, { op: 'extract', part: 'dayOfWeek' }, { op: 'addDays', amount: 1 }, { op: 'addHours', amount: -3 },
    { op: 'addMinutes', amount: 0 }, { op: 'addMinutes', amount: 'x' }, { op: 'weekNumber' },
    { format: 'docx' }, { content: 'c' }, { content: 'c', format: 'docx', fileName: 'f' }, { content: 'c', title: 'T', preset: 'bold' },
    { content: 'c', logo: 'none' }, { content: 'c', preset: 'p', logo: 'none' },
    { title: ' Omzet ' }, { image: 'x.png', forEach: {} }, { chart: {} }, { chart: { type: 'pie' }, title: 't' }, { stats: [1] }, { content: 'x', layout: 'timeline' },
    { slides: '' }, { slides: [] }, { slides: null }, { slides: 'md', format: 'pdf' }, { slides: ['a'], fileName: 'deck', preset: 'x', logo: 'none' },
    { documentId: 'd' }, { documentId: 'd', values: { a: 1 } }, { documentId: 'd', values: { a: 1, b: 2 }, documentName: 'Factuur' },
    { fields: [{ name: 'datum' }, { name: ' ' }, null, { name: 3 }] }, { fields: Array.from({ length: 8 }, (_, i) => ({ name: `f${i}` })) },
    { seconds: 7200 }, { seconds: 0 }, { seconds: 5400 },
    { prompt: '' }, { prompt: 'Approve the invoice?\nMore context' }, { prompt: 'x'.repeat(80) },
    { approval: { expiresInHours: 0 } }, { approval: { expiresInHours: 5 } }, { approval: { expiresInHours: 1 } }, { expiresInHours: 48 },
    { approval: { expiresInHours: 'x' } }, { approval: { expiresInHours: 24 } },
    { arrayRef: 's1.output.messages[*].attachments' }, { arrayRef: 'steps.s1.output.messages[*].attachments', parents: [{ overRef: 'steps.s1.output.messages' }] },
    { arrayRef: 'steps.s1.output.messages', parents: [] },
];

const FNS = [
    'limitSummary', 'dedupeSummary', 'aggregateSummary', 'datatableSummary', 'knowledgeWriteSummary', 'summarizeSummary',
    'dateTimeSummary', 'generateDocumentSummary', 'slideSummary', 'presentationSummary', 'fillDocumentSummary',
    'dataExtractionSummary', 'waitSummary', 'approvalSummary', 'approvalDeadline', 'flattenSummary',
] as const;

describe('node summaries', () => {
    const ctxs = [undefined, { stepLabelById: LABELS }, { tableNameById: { t1: 'Customers' }, kbNameById: { k1: 'Handbook' } }, { tableNameById: {} }];
    const steps = [...MATRIX, ...DEFS.flatMap((d) => d.steps as Record<string, unknown>[])];
    it.each(FNS)('%s agrees on every step and context', (fn) => {
        for (const step of steps) {
            for (const ctx of ctxs) {
                const port = ((summaries as Record<string, unknown>)[fn] as (s: unknown, c?: unknown) => unknown)(step, ctx);
                expect({ step, ctx, out: port }).toEqual({ step, ctx, out: webSummaries[fn](step, ctx) });
            }
        }
    });

    it('answers for a missing step where the web does', () => {
        expect(summaries.dataExtractionSummary(null)).toEqual(webSummaries.dataExtractionSummary(null));
        expect(summaries.approvalDeadline(null)).toBe(webSummaries.approvalDeadline(null));
    });
});

describe('display helpers', () => {
    const TOOLS = [null, 5, '', 'gmail_send', 'nextcloud_tasks_create', 'elevenlabs_tts', 'my__odd_tool', 'x_y_z'];
    const CATALOG = {
        apps: [
            { label: 'Gmail', actions: [{ name: 'gmail_send', label: 'Send' }, { name: 'gmail_search' }] },
            { actions: [{ name: 'x_y_z', integrationLabel: 'X' }, null] },
            { label: '', actions: [{ name: 'nextcloud_tasks_create' }] },
            {},
        ],
    } as unknown as Parameters<typeof display.actionDisplayLabel>[1];
    it.each(TOOLS.map((t) => [String(t), t] as const))('tool names %s', (_l, tool) => {
        expect(display.humanizeToolName(tool)).toBe(webDisplay.humanizeToolName(tool));
        expect(display.actionDisplayLabel(tool)).toBe(webDisplay.actionDisplayLabel(tool));
        expect(display.actionDisplayLabel(tool, CATALOG)).toBe(webDisplay.actionDisplayLabel(tool, CATALOG));
    });

    const KEYS = [null, '', '  ', 'subject', 'from_email', 'messageId', 'htmlUrl', 'pdf_file', 'AI score', 'a.b-c', '__', 'results[*].from_email', 'items[0].id'];
    it.each(KEYS.map((k) => [String(k), k] as const))('field keys %s', (_l, key) => {
        expect(display.humanizeFieldKey(key)).toBe(webDisplay.humanizeFieldKey(key));
        expect(display.humanizeFieldTail(key)).toBe(webDisplay.humanizeFieldTail(key));
    });

    const EXPRS = [
        null, '', 'steps.ai_a9afb3.output.urgentie == "hoog"', 'steps.s1.output', 'steps.zz.output.a[0].b', 'loop.item.total > 3',
        'loop.x', 'trigger.output.name', 'trigger', '"steps.s1.output" == x', 'contains(item.subject, "isv")',
        'item.amount > 1000 && item.paid == false', 'a || b', 'isEmpty(item.tags)', 'item.a == steps.s1.output.b',
        'item.a == null', 'item.a == 3', 'len(x) > 1', 'true', 'item.a == ""',
    ];
    it.each(EXPRS.map((e) => [String(e), e] as const))('expressions %s', (_l, expr) => {
        expect(display.humanizeExpression(expr)).toBe(webDisplay.humanizeExpression(expr));
        expect(display.humanizeExpression(expr, LABELS)).toBe(webDisplay.humanizeExpression(expr, LABELS));
        expect(display.describeRuleExpr(expr, LABELS)).toBe(webDisplay.describeRuleExpr(expr, LABELS));
    });

    // Condition node: every row shape the builder writes reads as the same sentence.
    const RULES = [
        ...EXPRS, 'false', 'equals(item.status, "open")', '!equals(item.status, "Open")', 'item.status == "Open"',
        'anyOf(item.attachments[*].filename, "endsWith", ".pdf")', 'everyOf(item.lines[*].qty, ">", 0)', 'noneOf(item.labels[*].name, "equals", "spam")',
        'anyOf(item.attachments[*].name, "!isEmpty")', 'equals(fileType(item), "pdf")', '!equals(fileType(item), "word")',
        'anyOf(fileType(item.attachments[*]), "equals", "pdf")', 'equals(fileType(item.name), "excel")', 'contains(item.attachments[*].mimeType, "pdf")',
        '!contains(item.attachments[*].mimeType, "pdf")', 'isEmpty(item.attachments)', '!isEmpty(item.notes)', 'item.when > "2026-01-01"',
        'contains(item.fields["Story Points"], "3")', 'item.headers[name="Subject"].value == "x"', 'steps.s1.output.urgency == "high"',
        'trigger.output.ok == true', 'vars.limit > 3', 'loop.row.total >= 2', 'contains(item.from, "fabrikam") || equals(fileType(item), "pdf")',
        'item.a == steps.s1.output.b', 'steps.s1.output.results[*]', 'len(item.a) > 1 && item.b',
    ];
    const t = (key: string, en: string, vars?: Record<string, unknown>) => `[${key}|${en}|${JSON.stringify(vars ?? {})}]`;
    it.each(RULES.map((e) => [String(e), e] as const))('rule sentences %s', (_l, expr) => {
        expect(display.ruleSentence(expr)).toBe(webDisplay.ruleSentence(expr));
        expect(display.ruleSentence(expr, LABELS, t)).toBe(webDisplay.ruleSentence(expr, LABELS, t));
        expect(display.describeRuleExpr(expr, LABELS)).toBe(webDisplay.describeRuleExpr(expr, LABELS));
        expect(display.describeRuleExpr(expr, null, t)).toBe(webDisplay.describeRuleExpr(expr, null, t));
    });

    it.each(DEFS.map((d, i) => [i, d] as const))('label map %i', (_i, def) => {
        expect([...display.buildStepLabelMap(def)]).toEqual([...webDisplay.buildStepLabelMap(def)]);
    });

    it('builds an empty map for no definition', () => {
        expect(display.buildStepLabelMap(null).size).toBe(0);
    });
});
