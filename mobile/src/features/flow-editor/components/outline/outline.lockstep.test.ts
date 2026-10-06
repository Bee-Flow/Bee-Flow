/**
 * Lockstep: the outline's ports of web card logic, held to the web files.
 *
 *   DIFFERENTIAL  setSummary.ts ↔ flow/setOperations.js and stepResult.ts ↔
 *                 flow/stepResultChip.js, and the AI step's variant ↔
 *                 flow/aiToolNodes.js, run on the same inputs;
 *   TEXTUAL       stepIcons.ts ↔ the icon each node component draws
 *                 (flow/nodes/*Node.jsx, found through flow/nodeTypes.js),
 *                 and the lane words ↔ the port labels on the web cards.
 */

import fs from 'node:fs';
import path from 'node:path';

import { FIXTURES } from '@/features/flow-editor/model/testing/fixtures';
import { loadWebModule } from '@/shared/testing/webModule';
import { isIconName } from '@/shared/ui';

import { describeSetOperation, summariseSetStep } from './setSummary';
import { AI_STEP_ICON, aiStepVariant, APP_EVENT_ICON, DATATABLE_OP_ICON, TRIGGER_ICON, TYPE_ICON } from './stepIcons';
import { describeStepResult } from './stepResult';

const FLOW = path.resolve(__dirname, '../../../../../../agent-hub/src/components/automation/Builder/flow');
/* eslint-disable @typescript-eslint/no-require-imports */
const webSet = require(`${FLOW}/setOperations.js`);
const webResult = require(`${FLOW}/stepResultChip.js`);
// Loaded as text: the file imports lucide-react through nodeTypeColors, which
// the app's own node_modules (all that CI installs for mobile) does not hold.
// aiStepVariant uses none of its imports, so they are stubbed.
const webAiTools = loadWebModule<{ aiStepVariant: (step: unknown) => string }>('components/automation/Builder/flow/aiToolNodes.js', {
    cardHeightForPorts: () => 0,
    CARD_H: 0,
    routePorts: () => [],
});
/* eslint-enable @typescript-eslint/no-require-imports */

const read = (rel: string) => fs.readFileSync(path.join(FLOW, rel), 'utf8');

describe('the Edit-data summary', () => {
    const OPS: unknown[] = [
        null, 'x', {}, { op: 'rowId' }, { op: 'rowId', target: 'nr' }, { op: 'groupId', keys: ['subject', ' ', 3] }, { op: 'groupId' },
        { op: 'rename', from: 'a', to: 'b' }, { op: 'rename', from: 'a' }, { op: 'keep', keys: ['a'] }, { op: 'keep', keys: [] },
        { op: 'remove', keys: ['a', 'b'] }, { op: 'remove' }, { op: 'sort', key: 'amount', direction: 'desc' }, { op: 'sort' }, { op: 'bogus' },
    ];
    const STEPS: unknown[] = [
        null, {}, { fields: { a: 1 } }, { fields: { first_name: 1, b: 2, c: 3, d: 4, e: 5 } }, { arrayRef: 'x' },
        { arrayRef: 'x', fields: { a: 1 } }, { arrayRef: 'x', operations: OPS }, { arrayRef: 'x', fields: { a: 1, b: 2 }, operations: OPS.slice(3, 5) },
        ...Object.values(FIXTURES).flatMap((d) => d.steps.filter((s) => s.type === 'set')),
    ];

    it('describes every operation as the web does', () => {
        for (const op of OPS) expect(describeSetOperation(op)).toBe(webSet.describeSetOperation(op));
    });

    it('summarises every step as the web does', () => {
        for (const step of STEPS) expect(summariseSetStep(step as Record<string, unknown>)).toBe(webSet.summariseSetStep(step));
    });
});

describe('the run result chip', () => {
    const t = (key: string, fallback: string, params?: Record<string, string | number>) =>
        `${key}|${fallback.replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''))}`;
    const ROWS: unknown[] = [
        null, {}, { status: 'running' }, { status: 'queued' }, { status: 'awaiting_approval' }, { status: 'error' }, { status: 'FAILED' },
        { status: 'skipped' }, { status: 'success' }, { status: 'success', output: null }, { status: 'success', output: [1, 2] },
        { status: 'success', output: [] }, { status: 'success', output: '' }, { status: 'success', output: 'abc' },
        { status: 'success', output: { __truncated__: true } }, { status: 'success', output: { files: [1] } }, { status: 'success', output: { rows: [] } },
        { status: 'success', output: { results: [1, 2, 3] } }, { status: 'success', output: { appended: true } }, { status: 'success', output: { sent: 1 } },
        { status: 'success', output: {} }, { status: 'success', output: { a: 1 } }, { status: 'success', output: 7 }, { status: 'success', output: false },
    ];

    it('says what the web chip says', () => {
        for (const row of ROWS) expect(describeStepResult(row as { status?: unknown }, t)).toBe(webResult.describeStepResult(row, t));
        expect(describeStepResult({ status: 'success' }, null)).toBe(webResult.describeStepResult({ status: 'success' }, null));
    });
});

describe('the card glyphs', () => {
    const nodeTypes = read('nodeTypes.js');
    const componentFor = (type: string) => new RegExp(`^\\s+${type}:\\s+(\\w+),`, 'm').exec(nodeTypes)?.[1];

    /** The `icon={…}` line StepNodeBase is handed (a note is no step card: its import says it). */
    const iconLine = (src: string) => /^\s+icon=\{.*$/m.exec(src)?.[0] ?? /^import .* from 'lucide-react';$/m.exec(src)?.[0] ?? '';

    it.each(Object.entries(TYPE_ICON).filter(([type]) => type !== 'datatable'))('%s draws %s, as its node component does', (type, icon) => {
        const component = componentFor(type);
        expect(component).toBeTruthy();
        expect(iconLine(read(`nodes/${component}.jsx`))).toMatch(new RegExp(`\\b${icon}\\b`));
    });

    // Handoff 5 split the AI step card into three variants, each with its own
    // glyph (AiStepNode's VARIANT_ICON), so its icon line names a variable.
    it('draws an AI step by its variant, as AiStepNode does', () => {
        const node = read(`nodes/${componentFor('ai_step')}.jsx`);
        expect(iconLine(node)).toMatch(/icon=\{<Icon size=\{14\} \/>\}/);
        expect(node).toMatch(/const Icon = VARIANT_ICON\[variant\];/);
        const table = /const VARIANT_ICON = \{([^}]*)\};/.exec(node)?.[1] ?? '';
        expect(Object.fromEntries([...table.matchAll(/(\w+): (\w+)/g)].map((m) => [m[1], m[2]]))).toEqual(AI_STEP_ICON);
        const steps: unknown[] = [
            null, {}, { agentId: 'a' }, { agentId: '' }, { agentId: 5, skillIds: ['s'] }, { skillIds: ['', 3] }, { skillIds: 's' },
            { agentId: 'a', skillIds: ['s'] }, { skillIds: [null, 'x'] },
        ];
        for (const step of steps) expect(aiStepVariant(step)).toBe(webAiTools.aiStepVariant(step));
    });

    it('draws the datatable operations, the trigger kinds and the app events as TriggerNode and DatatableNode do', () => {
        const table = read('nodes/DatatableNode.jsx');
        for (const [op, icon] of Object.entries(DATATABLE_OP_ICON)) expect(table).toMatch(new RegExp(`${op}: ${icon},`));
        const trigger = read('nodes/TriggerNode.jsx');
        for (const [kind, icon] of Object.entries(TRIGGER_ICON)) expect(trigger).toMatch(new RegExp(`${kind}:\\s+${icon},`));
        for (const [event, icon] of Object.entries(APP_EVENT_ICON)) expect(trigger).toMatch(new RegExp(`'${event.replace(/\./g, '\\.')}':\\s+${icon},`));
        expect(read('nodes/FormPageNode.jsx')).toMatch(/isEnding \? <CheckCircle2/);
    });

    it('can draw every one of them', () => {
        const all = [...Object.values(TYPE_ICON), ...Object.values(AI_STEP_ICON), ...Object.values(TRIGGER_ICON), ...Object.values(APP_EVENT_ICON), ...Object.values(DATATABLE_OP_ICON)];
        expect(all.filter((name) => !isIconName(name))).toEqual([]);
    });
});

describe('the lane words', () => {
    it('are the port labels on the web cards', () => {
        expect(read('nodes/ConditionNode.jsx')).toMatch(
            /\{ id: 'then', label: t\('condition_node\.port\.match', 'Match'\)[^}]*\},\s*\{ id: 'else', label: t\('condition_node\.otherwise\.label', 'Otherwise'\)/,
        );
        expect(read('nodes/GuardNode.jsx')).toMatch(/\{ id: 'then', label: 'personal data'[^}]*\},\s*\{ id: 'else', label: 'clean'/);
        expect(read('nodes/SwitchNode.jsx')).toMatch(/\{ id: 'case:default', label: t\('condition_node\.otherwise\.label', 'Otherwise'\)/);
        expect(read('nodes/LoopNode.jsx')).toMatch(/t\('automations\.canvas\.loop_port_on_error', 'On error'\)/);
    });
});
