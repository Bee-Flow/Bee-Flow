import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { hiddenTabsFor, useRailGroups } from './useProjectRailData';

vi.mock('../../../hooks/useTranslation', () => ({
    default: () => ({ t: (_k: string, f: string) => f, locale: 'en' }),
    useTranslation: () => ({ t: (_k: string, f: string) => f, locale: 'en' }),
}));

describe('hiddenTabsFor', () => {
    it('hides notebooks when they are off and tasks for a Solution', () => {
        expect(hiddenTabsFor({ kind: 'workspace' }, true)).toEqual([]);
        expect(hiddenTabsFor({ kind: 'workspace' }, false)).toEqual(['notebooks']);
        expect(hiddenTabsFor({ kind: 'solution' }, true)).toEqual(['tasks']);
        expect(hiddenTabsFor({ kind: 'solution' }, false)).toEqual(['notebooks', 'tasks']);
        expect(hiddenTabsFor(null, true)).toEqual([]);
    });
});

describe('useRailGroups', () => {
    it('is three groups in the rail order, without the hidden rows', () => {
        const { result } = renderHook(() => useRailGroups(['notebooks']));
        expect(result.current.map((g) => g.id)).toEqual(['collaborate', 'content', 'manage']);
        expect(result.current.map((g) => g.items.map((i) => i.id))).toEqual([
            ['overview', 'chats', 'tasks', 'meetings'],
            ['documents', 'knowledge'],
            ['members', 'activity', 'settings'],
        ]);
    });
});
