/**
 * DIFFERENTIAL lockstep: the run overlay's ports against the web builder.
 *
 *   runStatus.ts ↔ flow/runStatus.js  (effectiveRunByStep)
 *   runFocus.ts  ↔ flow/runFocus.js   (computeRunFocus, formatElapsed)
 *   runRows.ts   ↔ DryRunPanel.jsx    (friendlyStepName, buildNameMap and
 *                                       stripDryRunMeta, evaluated from the
 *                                       component file's own source: they are
 *                                       module-private there)
 *
 * and, by text, the dry-run flags DryRunPanel reads off an output.
 *
 * inlineFlowlets.js holds a React hook, so its id helper stands in, as in
 * addNode.lockstep.test.ts.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { FlowDefinition } from '@/features/flow-editor/model';
import { clone, FIXTURES, templateDefinitions } from '@/features/flow-editor/model/testing/fixtures';

import { computeRunFocus, formatElapsed } from './runFocus';
import { buildNameMap, DRY_RUN_META_KEYS, friendlyStepName, stripDryRunMeta } from './runRows';
import { effectiveRunByStep } from './runStatus';

jest.mock('../../../../../../agent-hub/src/components/automation/Builder/flow/inlineFlowlets', () => ({
    isInlineId: (id: unknown) => typeof id === 'string' && id.includes('/'),
}));

const BUILDER = path.resolve(__dirname, '../../../../../../agent-hub/src/components/automation/Builder');
/* eslint-disable @typescript-eslint/no-require-imports */
const webStatus = require(`${BUILDER}/flow/runStatus.js`);
const webFocus = require(`${BUILDER}/flow/runFocus.js`);
const webDisplay = require(`${BUILDER}/flow/displayHelpers.js`);
const TEMPLATES_JS = path.resolve(__dirname, '../../../../../../server/automation/templates.js');
const TEMPLATES = templateDefinitions(fs.readFileSync(TEMPLATES_JS, 'utf8'), require(TEMPLATES_JS).getTemplate);
/* eslint-enable @typescript-eslint/no-require-imports */

const PANEL = fs.readFileSync(`${BUILDER}/DryRunPanel.jsx`, 'utf8');

/** A module-private function of DryRunPanel.jsx, as its source defines it. */
function panelFunction(name: string, deps: Record<string, unknown> = {}): (...args: unknown[]) => unknown {
    const start = PANEL.indexOf(`function ${name}(`);
    const end = PANEL.indexOf('\n}\n', start) + 2;
    const body = PANEL.slice(start, end);
    return new Function(...Object.keys(deps), `${body}\nreturn ${name};`)(...Object.values(deps));
}

const META_LINE = /const DRY_RUN_META_KEYS = (\[[^\]]*\]);/.exec(PANEL)?.[1] ?? '[]';
const webMetaKeys: string[] = new Function(`return ${META_LINE};`)();
const webFriendly = panelFunction('friendlyStepName', { humanizeToolName: webDisplay.humanizeToolName });
const webNameMap = panelFunction('buildNameMap', { friendlyStepName: webFriendly });
const webStrip = panelFunction('stripDryRunMeta', { DRY_RUN_META_KEYS: webMetaKeys });

/** The web writes English; the port asks for words — the fallback is the English. */
const english = (_key: string, fallback: string) => fallback;

const DEFINITIONS: FlowDefinition[] = [...Object.values(FIXTURES), ...Object.values(TEMPLATES)].map(clone);

const PINNED: FlowDefinition = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual', pinnedOutput: { name: 'x' } },
    triggers: [{ id: 'wh', type: 'trigger', kind: 'webhook', pinnedOutput: { __truncated__: true } }],
    steps: [
        { id: 's1', type: 'integration_action', tool: 'gmail_send_email' },
        { id: 's2', type: 'set', pinnedOutput: { results: [1, 2, 3] } },
        { id: 'cl/s3', type: 'set', label: 'Inline' },
        { id: 's4', type: 'call_layer', layerKey: 'lk' },
        { id: 's5', type: 'layer_output' },
        { id: 's6', type: 'datetime', label: '  ' },
    ],
    edges: [],
    layers: { lk: { title: 'Sub flow', trigger: { id: 'li', type: 'trigger', kind: 'layer_input' }, steps: [{ id: 'in1', type: 'set', label: 'Inner' }], edges: [] } },
};

const ROWS = [
    { stepId: 's1', status: 'success', output: { a: 1 }, attempts: 1, startedAt: '2026-09-01T10:00:00Z' },
    { stepId: 's1', status: 'error', attempts: 2, startedAt: '2026-09-01T10:00:05Z' },
    { stepId: 's1', status: 'success', attempts: 2, startedAt: '2026-09-01T10:00:01Z' },
    { stepId: 's1', parentStepId: 'cl1', status: 'success', output: { sub: 1 } },
    { stepId: 'cl/s3', parentStepId: 'cl', status: 'running', startedAt: '2026-09-01T09:59:00Z' },
    { stepId: 'ghost', status: 'error' },
    { stepId: 's2', status: 'success', output: { fresh: true } },
    { stepId: 'trg', status: 'awaiting_form' },
    { status: 'success' },
    null,
];

describe('effectiveRunByStep', () => {
    const cases: [FlowDefinition | null, unknown[] | null][] = [
        [null, null],
        [PINNED, []],
        [PINNED, ROWS],
        [PINNED, ROWS.slice(0, 3).reverse()],
        ...DEFINITIONS.map((d): [FlowDefinition, unknown[]] => [d, d.steps.slice(0, 3).map((s, i) => ({ stepId: s.id, status: i ? 'success' : 'error', attempts: i }))]),
    ];

    it.each(cases.map((c, i) => [i, ...c] as const))('case %i matches the web', (_i, def, rows) => {
        const mine = effectiveRunByStep(def, rows as never);
        const web: Map<string, unknown> = webStatus.effectiveRunByStep(def, rows);
        expect([...mine.entries()]).toEqual([...web.entries()]);
    });
});

describe('computeRunFocus', () => {
    const cases: { runSteps?: unknown[]; runInFlight?: boolean; definition?: FlowDefinition | null }[] = [
        {},
        { runInFlight: true },
        { runInFlight: true, definition: PINNED },
        { runSteps: ROWS, definition: PINNED },
        { runSteps: ROWS, definition: PINNED, runInFlight: true },
        { runSteps: [{ stepId: 's1', status: 'error' }, { stepId: 's2', status: 'success', startedAt: 'nonsense' }], definition: PINNED },
        { runSteps: [{ stepId: 's1', status: 'error' }], definition: PINNED, runInFlight: true },
        { runSteps: [{ stepId: 'ghost', status: 'error' }], definition: PINNED },
        { runSteps: [{ stepId: 's1', status: 'success' }, { stepId: 's2', status: 'pinned' }, { stepId: 's6', status: 'skipped' }], definition: PINNED, runInFlight: true },
        ...DEFINITIONS.map((d) => ({
            definition: d,
            runSteps: d.steps.map((s, i) => ({ stepId: s.id, status: i === d.steps.length - 1 ? 'running' : 'success', startedAt: `2026-09-01T10:0${i % 10}:00Z` })),
        })),
    ];

    it.each(cases.map((c, i) => [i, c] as const))('case %i matches the web', (_i, input) => {
        expect(computeRunFocus(input as never)).toEqual(webFocus.computeRunFocus(input));
    });

    it('formats elapsed time as the web does', () => {
        const now = Date.parse('2026-09-01T12:00:00Z');
        for (const start of ['', 'nonsense', '2026-09-01T11:59:59Z', '2026-09-01T11:59:00Z', '2026-09-01T11:47:27Z', '2026-09-01T09:12:00Z', '2026-09-01T12:00:05Z']) {
            expect(formatElapsed(start, now)).toBe(webFocus.formatElapsed(start, now));
        }
    });
});

describe('the result sheet', () => {
    it('strips the same plumbing flags', () => {
        expect([...DRY_RUN_META_KEYS]).toEqual(webMetaKeys);
        const values: unknown[] = [null, 3, 'x', [1], { a: 1 }, { _dryRun: true, wouldHaveCalled: 't' }, { _dryRunSynthesised: true, _dryRunFallback: 'live_empty', rows: [] }];
        for (const v of values) expect(stripDryRunMeta(v)).toEqual(webStrip(v));
    });

    it('names every step as the web does', () => {
        for (const def of [PINNED, ...DEFINITIONS]) {
            const nodes = [def.trigger, ...def.steps, null, { id: 'z', type: 'call_layer', label: 'Named' }];
            for (const node of nodes) expect(friendlyStepName(node as never, def, english)).toBe(webFriendly(node, def));
            expect([...buildNameMap(def, english).entries()]).toEqual([...(webNameMap(def) as Map<string, string>).entries()]);
        }
        expect(buildNameMap(null, english).size).toBe(0);
    });

    it('reads the dry-run flags DryRunPanel reads', () => {
        for (const needle of ['out.wouldNotify', 'out._dryRun', 'out._dryRunSynthesised', "'live_failed'", "'live_empty'", 'out.wouldHaveCalled', 'out.withArgs', '!s.parentStepId']) {
            expect(PANEL).toContain(needle);
        }
    });
});
