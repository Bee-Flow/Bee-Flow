// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getPath } from '@shared/expr/path.mjs';
import { loopBodyPreview } from './loopBodyPreview';
import { computeLoopBodyGroups as computeLoopBodyGroupsJs } from './upstream';

/**
 * Inside a Loop's body, `loop.<itemVar>` previews ONE item, the first, as the
 * run's first iteration binds it: its own values (also an empty one) and its
 * own lists, never the rows' lists strung together. Keys only a later row has
 * are filled in, so they are still offered.
 */
type Field = { path: string; sample: unknown; children?: Field[] };
type Group = { basePath: string; sample: unknown; fields: Field[] };
const computeLoopBodyGroups = computeLoopBodyGroupsJs as (...a: unknown[]) => Group[];

const M1 = { id: 'm1', note: '', attachments: [{ id: 'a1' }, { id: 'a2' }], from: { name: 'Ann' } };
const M2 = { id: 'm2', note: 'urgent', attachments: [{ id: 'a3', mime: 'pdf' }], from: { name: 'Bob', address: 'b@x' } };
const ROOT = { steps: { list: { output: { value: [M1, M2] } } } };
const LOOP = { id: 'lp', type: 'loop', itemVar: 'mail', overRef: 'steps.list.output.value', body: [] };

const flat = (fields: Field[]): Field[] => fields.flatMap(f => [f, ...flat(f.children || [])]);

describe("a Loop body's current item", () => {
    it('the preview root holds the first item, its gaps filled from the others', () => {
        const root = loopBodyPreview(LOOP, ROOT);
        expect(getPath(root, 'loop.mail.note')).toBe('');
        expect(getPath(root, 'loop.mail.attachments')).toEqual(M1.attachments);
        expect(getPath(root, 'loop.mail.from')).toEqual({ name: 'Ann', address: 'b@x' });
    });

    it('the body editor\'s item group shows the first item and still offers what only later items have', () => {
        const item = computeLoopBodyGroups(LOOP, 0, [], ROOT, null, { steps: [] }).find(g => g.basePath === 'loop.mail') as Group;
        expect(item.sample).toEqual({ ...M1, from: { name: 'Ann', address: 'b@x' } });
        const fields = flat(item.fields);
        expect(fields.find(f => f.path === 'loop.mail.note')?.sample).toBe('');
        expect(fields.find(f => f.path === 'loop.mail.attachments')?.sample).toEqual(M1.attachments);
        expect(fields.map(f => f.path)).toContain('loop.mail.attachments[*].mime');
        expect(fields.map(f => f.path)).toContain('loop.mail.from.address');
    });

    it('a list of plain values previews its first value', () => {
        const root = { steps: { list: { output: { value: [3, 4] } } } };
        const item = computeLoopBodyGroups(LOOP, 0, [], root, null, { steps: [] }).find(g => g.basePath === 'loop.mail') as Group;
        expect(item.sample).toBe(3);
        expect(getPath(loopBodyPreview(LOOP, root), 'loop.mail')).toBe(3);
    });
});
