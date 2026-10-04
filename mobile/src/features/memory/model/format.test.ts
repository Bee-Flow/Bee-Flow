/** The memory list's words: the line a row shows, and the type chips the stats produce. */

import { capitalise, countsByType, memoryLine, truncate, typeChips } from './format';
import type { Memory, MemoryStats } from './types';

const memory = (over: Partial<Memory> = {}): Memory => ({
    id: 'm1',
    user_id: 'u1',
    agent_id: null,
    type: 'fact',
    content: 'Works in Utrecht',
    summary: null,
    importance: 0.5,
    status: 'active',
    project_id: null,
    created_at: '',
    updated_at: '',
    ...over,
});

const stats = (labels: string[], data: (number | null)[]): MemoryStats => ({
    total: 0,
    typeDistribution: { labels, data },
    importanceDistribution: { high: 0, medium: 0, low: 0 },
});

describe('memoryLine', () => {
    it('prefers a non-blank summary over the content', () => {
        expect(memoryLine(memory({ summary: 'Utrecht' }))).toBe('Utrecht');
        expect(memoryLine(memory({ summary: '   ' }))).toBe('Works in Utrecht');
    });
});

describe('truncate', () => {
    it('flattens whitespace and cuts with an ellipsis', () => {
        expect(truncate('a  b\nc')).toBe('a b c');
        expect(truncate('abcdefghij', 5)).toBe('abcd…');
    });
});

describe('countsByType and typeChips', () => {
    it('pairs the parallel arrays and skips a count that is not a number', () => {
        expect(countsByType(stats(['fact', 'person'], [3, null]))).toEqual({ fact: 3 });
        expect(countsByType(null)).toEqual({});
    });

    it('offers the known types that have rows, then any type this build does not know', () => {
        const chips = typeChips(stats(['person', 'automation_note', 'fact', 'project'], [2, 1, 4, 0]));
        expect(chips.map((c) => [c.id, c.count])).toEqual([
            ['person', 2],
            ['fact', 4],
            ['automation_note', 1],
        ]);
        expect(chips[2]?.label).toBe('Automation note');
    });
});

describe('capitalise', () => {
    it('raises only the first letter', () => {
        expect(capitalise('instruction')).toBe('Instruction');
        expect(capitalise('user_fact')).toBe('User_fact');
        expect(capitalise('')).toBe('');
    });
});
