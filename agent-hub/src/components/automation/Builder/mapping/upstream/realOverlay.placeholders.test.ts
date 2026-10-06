// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { computeUpstreamGroups, overlayGroupWithReal } from './index';
import { eachField, type Field } from './fieldTree';

/**
 * Once a step has run, what it REALLY returned is the truth. A key the
 * describer only guessed (an HTTP step's `data` "parsed body" placeholder)
 * must not survive next to the real output as "Data · not seen yet"; a
 * curated field the real output does have stays.
 */
const paths = (fields: Field[]) => {
    const out: string[] = [];
    eachField(fields, f => out.push(f.path));
    return out;
};

describe('real output replaces the placeholder sample', () => {
    it('an HTTP step that answered text has no `data` field after the run', () => {
        const def = {
            trigger: { id: 'trg', kind: 'manual' },
            steps: [{ id: 'h', type: 'http_request', url: 'https://x' }, { id: 'dst', type: 'notification', title: 't' }],
            edges: [{ from: 'trg', to: 'h' }, { from: 'h', to: 'dst' }],
        };
        const before = computeUpstreamGroups(def, 'dst', { apps: [], triggerOutputs: {} }).find((g: { id: string }) => g.id === 'h');
        expect(paths(before.fields)).toContain('steps.h.output.data');
        const out = { status: 200, ok: true, headers: {}, body: '{"a":1}', truncated: false };
        const after = overlayGroupWithReal(before, out);
        expect(paths(after.fields)).not.toContain('steps.h.output.data');
        expect(after.sample).toEqual(out);
        expect(paths(after.fields)).toContain('steps.h.output.body.a');
    });

    it('a curated field the real output has stays; one it lacks goes', () => {
        const group = {
            id: 'sw', kind: 'switch', basePath: 'steps.sw.output', sample: { matched: 'a', matchesByCase: { vip: [], other: [] } },
            fields: [
                { key: 'matchesByCase.vip', path: 'steps.sw.output.matchesByCase.vip', sample: [] },
                { key: 'matchesByCase.other', path: 'steps.sw.output.matchesByCase.other', sample: [] },
            ],
        };
        const after = overlayGroupWithReal(group, { matched: 'vip', matchesByCase: { vip: [{ id: 1 }] } });
        const all = paths(after.fields);
        expect(all).toContain('steps.sw.output.matchesByCase.vip');
        expect(all).not.toContain('steps.sw.output.matchesByCase.other');
        expect(new Set(all).size).toBe(all.length);
    });
});
