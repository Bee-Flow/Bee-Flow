/**
 * Auto-map for a step just added: with the last run's real outputs, queued
 * while the catalog loads, and off when the author switched it off. Then the
 * route is followed: the step after a Condition reads what it keeps (W1, W2).
 */

import type { FlowDefinition } from '@/features/flow-editor/model';
import { insertStep } from '@/features/flow-editor/model/outline';
import { clone, loopy } from '@/features/flow-editor/model/testing/fixtures';

import { autoMapInserted, followAround, reboundRouteId } from './autoMapInsert';

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

// The demo's shape: Read many → Read attachment, the attachments of every message.
const mails = (): FlowDefinition => ({
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [
        { id: 'rm', type: 'http_request', label: 'Read many', url: 'https://mail.example' },
        {
            id: 'ra', type: 'http_request', label: 'Read attachment', url: 'https://mail.example',
            forEach: { overRef: 'steps.rm.output.messages[*].attachments', parents: [{ overRef: 'steps.rm.output.messages' }] },
        },
    ],
    edges: [{ from: 'trg', to: 'rm' }, { from: 'rm', to: 'ra' }],
} as FlowDefinition);
const realMails = new Map<string, unknown>([['rm', { messages: [{ subject: 'Invoice', attachments: [{ filename: 'a.pdf' }] }] }]]);
const spliceCondition = () => insertStep(mails(), { kind: 'splice', sourceId: 'rm', targetId: 'ra', identity: { label: null, caseName: null } } as never, { kind: 'condition', label: 'Condition' });
const step = (def: FlowDefinition, id: string) => def.steps.find((s) => s.id === id) as Record<string, unknown> & { forEach?: { overRef?: string; parents?: { overRef: string }[] } };

describe('following the route on insert', () => {
    it('a Condition put on the connection makes the next step read what it keeps, in the same edit', () => {
        const out = autoMapInserted(spliceCondition(), { catalog, realOutputById: realMails });
        const cond = out.addedId as string;
        expect(step(out.definition, cond)).toMatchObject({ type: 'filter', arrayRef: 'steps.rm.output.messages' });
        expect(step(out.definition, 'ra').forEach).toEqual({
            overRef: `steps.${cond}.output.items[*].attachments`,
            parents: [{ overRef: `steps.${cond}.output.items` }],
        });
        expect(out.rebound).toEqual([{ stepId: 'ra', from: 'steps.rm.output.messages', to: `steps.${cond}.output.items` }]);
        expect(reboundRouteId(out.rebound[0] as never)).toBe(cond);
    });

    it('re-points nothing while the Condition has no list, and with auto-map off follows a list it already has', () => {
        const unmapped = autoMapInserted(spliceCondition(), { catalog, autoMap: false });
        expect(unmapped.rebound).toEqual([]);
        expect(step(unmapped.definition, 'ra').forEach?.overRef).toBe('steps.rm.output.messages[*].attachments');
        const def = mails();
        def.steps.push({ id: 'sw', type: 'switch', arrayRef: 'steps.rm.output.messages', routeStyle: 'rules', cases: [{ name: 'pdf', expr: 'a' }, { name: 'word', expr: 'b' }] } as never);
        const added = insertStep(def, { kind: 'after', sourceId: 'sw', handle: 'case:word' }, { kind: 'set' });
        const id = added.addedId as string;
        const withRead = { ...added.definition, steps: added.definition.steps.map((s) => (s.id === id ? { ...s, inputs: { n: { kind: 'ref', path: 'steps.sw.output.matchesByCase.pdf' } } } : s)) };
        const followed = autoMapInserted({ ...added, definition: withRead as FlowDefinition }, { catalog, autoMap: false });
        expect(step(followed.definition, id).inputs).toEqual({ n: { kind: 'ref', path: 'steps.sw.output.matchesByCase.word' } });
        expect(followed.rebound).toEqual([{ stepId: id, from: 'steps.sw.output.matchesByCase.pdf', to: 'steps.sw.output.matchesByCase.word' }]);
    });

    it('follows nothing for a step that hangs off no list Condition', () => {
        const def = mails();
        expect(followAround(def, 'ra')).toEqual({ definition: def, rebound: [] });
        expect(reboundRouteId({ stepId: 'x', from: 'a', to: 'trigger.output.items' })).toBeNull();
    });
});
