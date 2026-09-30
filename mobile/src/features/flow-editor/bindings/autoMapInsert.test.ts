/**
 * Auto-map for a step just added: with the last run's real outputs, queued
 * while the catalog loads, and off when the author switched it off.
 */

import type { FlowDefinition } from '@/features/flow-editor/model';
import { insertStep } from '@/features/flow-editor/model/outline';
import { clone, loopy } from '@/features/flow-editor/model/testing/fixtures';

import { autoMapInserted } from './autoMapInsert';

const withHttp = (): FlowDefinition => ({
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [{ id: 'h1', type: 'http_request', label: 'Fetch', url: 'https://example.test' }],
    edges: [{ from: 'trg', to: 'h1' }],
});
const catalog = { apps: [] };
const loopOver = (def: FlowDefinition, id: string | null) => def.steps.find((s) => s.id === id)?.overRef;
const addLoop = () => insertStep(withHttp(), { kind: 'after', sourceId: 'h1', handle: null }, { kind: 'loop' });

describe('auto-map on insert', () => {
    it('reads what the step before really produced', () => {
        const real = new Map<string, unknown>([['h1', { items: [{ n: 1 }] }]]);
        const blind = autoMapInserted(addLoop(), { catalog });
        const seen = autoMapInserted(addLoop(), { catalog, realOutputById: real });
        expect(loopOver(seen.definition, seen.addedId)).toBe('steps.h1.output.items');
        expect(seen.mapped).toBe(1);
        expect(loopOver(blind.definition, blind.addedId)).not.toBe('steps.h1.output.items');
    });

    it('waits for the catalog instead of skipping, and maps nothing when switched off', () => {
        expect(autoMapInserted(addLoop())).toMatchObject({ awaitingCatalog: true, mapped: 0 });
        const real = new Map<string, unknown>([['h1', { items: [{ n: 1 }] }]]);
        expect(autoMapInserted(addLoop(), { catalog, realOutputById: real, autoMap: false })).toMatchObject({ awaitingCatalog: false, mapped: 0 });
        const held = insertStep(clone(loopy), { kind: 'inline', container: 'loop_1', branch: null, index: 0 }, { kind: 'set' });
        expect(autoMapInserted(held).awaitingCatalog).toBe(false);
    });
});
