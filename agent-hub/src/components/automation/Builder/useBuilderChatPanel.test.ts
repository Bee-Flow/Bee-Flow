import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useBuilderChatPanel from './useBuilderChatPanel';
import type { UseBuilderChatPanelOptions } from './useBuilderChatPanel';
import { queryWrapper } from '@/test/queryWrapper';
import scopedStorage, { setCurrentUser } from '@/utils/scopedStorage';

/**
 * Whether the assistant column is open. The person's own open/close is a
 * preference that survives reload; an empty draft (owner, 2026-11-04) and a
 * hosted mount open it without that being anybody's choice, so neither writes
 * the preference.
 */
const KEY = 'automationsAssistantOpen';

const mount = (initialProps: UseBuilderChatPanelOptions) => renderHook(
    (props: UseBuilderChatPanelOptions) => useBuilderChatPanel(props),
    { initialProps, wrapper: queryWrapper() },
);

describe('useBuilderChatPanel — is the assistant open?', () => {
    beforeEach(() => {
        localStorage.clear();
        setCurrentUser('u1');
        // The tier list is fetched on mount; it never answers here.
        vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    });
    afterEach(() => { vi.unstubAllGlobals(); setCurrentUser(null); });

    it('an automation with steps follows the stored preference (closed by default)', () => {
        const { result } = mount({ emptyDraft: false });
        expect(result.current.assistantOpen).toBe(false);
        scopedStorage.setItem(KEY, '1');
        expect(mount({ emptyDraft: false }).result.current.assistantOpen).toBe(true);
    });

    it('an empty draft opens it, and does not write the preference', () => {
        const { result } = mount({ emptyDraft: true });
        expect(result.current.assistantOpen).toBe(true);
        expect(scopedStorage.getItem(KEY)).toBeNull();
    });

    it('opens once a loaded draft turns out empty, and stays open when the first step lands', () => {
        const { result, rerender } = mount({ emptyDraft: false });
        expect(result.current.assistantOpen).toBe(false);
        rerender({ emptyDraft: true });
        expect(result.current.assistantOpen).toBe(true);
        rerender({ emptyDraft: false });
        expect(result.current.assistantOpen).toBe(true);
        expect(scopedStorage.getItem(KEY)).toBeNull();
    });

    it('the person closing it is their choice: remembered, and the empty draft does not reopen it', () => {
        const { result, rerender } = mount({ emptyDraft: true });
        act(() => result.current.setAssistantOpen(false));
        expect(result.current.assistantOpen).toBe(false);
        expect(scopedStorage.getItem(KEY)).toBe('0');
        rerender({ emptyDraft: true });
        expect(result.current.assistantOpen).toBe(false);
        act(() => result.current.setAssistantOpen((open) => !open));
        expect(result.current.assistantOpen).toBe(true);
        expect(scopedStorage.getItem(KEY)).toBe('1');
    });

    it('a hosted mount opens it and never writes the preference, not even on a close', () => {
        const { result } = mount({ forceAssistantOpen: true });
        expect(result.current.assistantOpen).toBe(true);
        act(() => result.current.setAssistantOpen(false));
        expect(result.current.assistantOpen).toBe(false);
        expect(scopedStorage.getItem(KEY)).toBeNull();
    });
});
