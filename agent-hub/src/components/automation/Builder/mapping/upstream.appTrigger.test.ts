// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { computeUpstreamGroups } from './upstream';
import { stub } from '@/test/mocks';

/**
 * app_trigger variables — declared trigger.params surface client-side as
 * trigger.output.<name> bindables (same declared-params path as layer_input),
 * with file params expanding to their runtime { fileId, name, mime, size,
 * url } shape so trigger.output.<name>.url is bindable.
 */

const CATALOG = { triggerOutputs: { __manual: { fields: [{ key: 'now', sample: 'x' }], sample: { now: 'x' } } } };

function definitionWith(params: unknown) {
    return {
        trigger: { id: 'trg', type: 'trigger', kind: 'app_trigger', params },
        steps: [{ id: 's1', type: 'notification', title: 'hi' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
}

describe('upstream — app_trigger declared params', () => {
    it('declared params become trigger.output.<name> fields without a catalog round-trip', () => {
        const groups = computeUpstreamGroups(stub<Parameters<typeof computeUpstreamGroups>[0]>(definitionWith([
            { name: 'title', type: 'string', required: true },
            { name: 'amount', type: 'number' },
        ])), 's1', CATALOG);
        const trig = groups.find(g => g.kind === 'trigger');
        expect(trig!.label).toBe('Studio App inputs');
        const paths = trig!.fields.map(f => f.path);
        expect(paths).toContain('trigger.output.title');
        expect(paths).toContain('trigger.output.amount');
        // NOT the __manual fallback.
        expect(paths).not.toContain('trigger.output.now');
    });

    it('a file param samples as the expanded runtime shape (url bindable)', () => {
        const groups = computeUpstreamGroups(stub<Parameters<typeof computeUpstreamGroups>[0]>(definitionWith([
            { name: 'doc', type: 'file', required: true },
        ])), 's1', CATALOG);
        const trig = groups.find(g => g.kind === 'trigger');
        const doc = trig!.fields.find(f => f.key === 'doc');
        expect(doc!.sample).toMatchObject({ mime: 'application/pdf' });
        expect(Object.keys(doc!.sample as Record<string, unknown>)).toEqual(expect.arrayContaining(['fileId', 'name', 'mime', 'size', 'url']));
        expect((trig!.sample as { doc: { url: string } }).doc.url).toBeTruthy();
    });
});
