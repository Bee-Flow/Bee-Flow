import { describe, it, expect } from 'vitest';
import { groupRows, listLook, peekPosition, rowLook } from './AppListRow';

describe('listLook / rowLook', () => {
    it('keeps the rows look (and anything unknown) on the original classes', () => {
        expect(listLook('rows', '')).toEqual({ listCls: 'flex flex-col gap-2', listStyle: undefined });
        expect(rowLook('rows', 'md', false).cls).toBe('flex items-center gap-2.5 border w-full text-left px-3 py-2');
        expect(rowLook('rows', 'md', true).style).toMatchObject({ background: 'var(--app-primary-soft)', borderColor: 'var(--app-primary)' });
    });

    it('gives cards more air and tiles their own grid', () => {
        expect(listLook('cards', ' x').listCls).toBe('flex flex-col gap-3 x');
        expect(listLook('tiles', '').listStyle).toEqual({ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' });
        expect(rowLook('cards', 'sm', false).style).toMatchObject({ borderColor: 'transparent', boxShadow: 'var(--app-shadow-1)' });
        expect(rowLook('tiles', 'md', false).cls).toContain('flex-col');
    });
});

describe('peekPosition', () => {
    it('opens to the right of the row when there is room', () => {
        expect(peekPosition({ top: 100, left: 0, right: 200 }, 1200, 800)).toEqual({ top: 100, left: 208, maxHeight: 684 });
    });

    it('flips to the left near the right edge, and stays on screen', () => {
        const at = peekPosition({ top: 790, left: 900, right: 1000 }, 1100, 800);
        expect(at.left).toBe(900 - 320 - 8);
        expect(at.top).toBe(680);
        expect(at.maxHeight).toBe(120);
    });
});

describe('groupRows', () => {
    const items = [{ s: 'b' }, { s: '' }, { s: 'a' }, { s: 'b' }, { s: null }];

    it('keeps empty values loose and first, orders by groupOrder then first-seen', () => {
        const { loose, sections } = groupRows(items, 's', ['a'], []);
        expect(loose.map(([, i]) => i)).toEqual([1, 4]);
        expect(sections.map((g) => g.name)).toEqual(['a', 'b']);
        expect(sections[1].entries.map(([, i]) => i)).toEqual([0, 3]);
    });

    it('labels a group from groupLabelMap, falling back to its value', () => {
        const { sections } = groupRows(items, 's', [], [{ value: 'b', label: 'Bee' }, { value: 'a', label: '' }]);
        expect(sections.map((g) => g.label)).toEqual(['Bee', 'a']);
    });
});
