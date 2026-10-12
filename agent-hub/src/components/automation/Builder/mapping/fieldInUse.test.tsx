import type { ComponentType } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { countFieldsInUse, fieldInUse } from './fieldInUse';
import { FieldRow as FieldRowJs } from './VariableTree';
import { computeUpstreamGroups as computeUpstreamGroupsJs } from './upstream';
import { NESTED_TEXT_OUTPUT } from './upstream/fixtures/discovery';
import { buildRealOutputMap } from './realOutputs';

/**
 * A step that reads `items[0].meta.ai.verdict.score` uses every level down to
 * Score: the rows the picker writes with `[*]`, through JSON text, are marked
 * "used", and the group says how many fields it reads.
 */
const computeUpstreamGroups = computeUpstreamGroupsJs as (...args: unknown[]) => Array<{ id: string; fields: Array<{ path: string }> }>;
const FieldRow = FieldRowJs as unknown as ComponentType<Record<string, unknown>>;
const BASE = 'steps.h.output.body.data.payload.items';
const USED = new Set([
    `${BASE}[0].meta.ai.verdict.score`,
    `${BASE}[0].meta.ai.verdict["reason code"]`,
    'steps.h.output.headers[name="Subject"].value',
]);

afterEach(cleanup);

describe('which rows a step uses', () => {
    it('marks every level down to the value, with [*] standing for the index', () => {
        for (const p of [`${BASE}`, `${BASE}[*].meta`, `${BASE}[*].meta.ai`, `${BASE}[*].meta.ai.verdict`, `${BASE}[*].meta.ai.verdict.score`, `${BASE}[*].meta.ai.verdict["reason code"]`]) {
            expect(fieldInUse(p, USED), p).toBe(true);
        }
        expect(fieldInUse(`${BASE}[*].sku`, USED)).toBe(false);
        expect(fieldInUse('steps.h.output.headers[name="subject"].value', USED)).toBe(true);
        expect(fieldInUse(`${BASE}[*].meta.ai.verdict.score`, null)).toBe(false);
    });

    it('counts the deepest fields the step reads', () => {
        const def = {
            trigger: { id: 'trg', kind: 'manual' },
            steps: [{ id: 'h', type: 'http_request', parseResponse: 'never' }, { id: 'dst', type: 'notification', title: 't' }],
            edges: [{ from: 'trg', to: 'h' }, { from: 'h', to: 'dst' }],
        };
        const real = buildRealOutputMap(def, [{ stepId: 'h', output: { status: 200, ok: true, headers: {}, truncated: false, ...NESTED_TEXT_OUTPUT } }]);
        const g = computeUpstreamGroups(def, 'dst', { apps: [], triggerOutputs: {} }, real).find((x: { id: string }) => x.id === 'h');
        const readsItems = new Set([...USED].filter(p => !p.includes('headers')));
        expect(countFieldsInUse(g?.fields, readsItems)).toBe(2);
    });

    it('a nested row shows the "used" pill', () => {
        const field = { key: 'score', path: `${BASE}[*].meta.ai.verdict.score`, sample: 0.93 };
        render(<FieldRow field={field} depth={3} previewSample={null} inUse={USED} human />);
        expect(screen.getByTestId('field-used-pill')).toBeTruthy();
    });
});
