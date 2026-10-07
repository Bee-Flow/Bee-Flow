import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import useEmbedVisitorState from './useEmbedVisitorState';

const VERSION = '2026-10-14T09:00:00.000Z';

describe('useEmbedVisitorState', () => {
    it('starts closed and silent: no sources, no notice, no chat-signals fields', () => {
        const { result } = renderHook(() => useEmbedVisitorState());
        expect(result.current.sourcesAllowed).toBe(false);
        expect(result.current.notice.state).toBe('off');
        expect(result.current.turnFields()).toEqual({});
    });

    it('opens the sources only on an explicit yes, and reads the notice from the payload', () => {
        const { result } = renderHook(() => useEmbedVisitorState());
        act(() => result.current.applyEmbedPayload({ showSources: 'yes', complianceNotice: { state: 'on', from: '2026-10-14', version: VERSION, signals: ['outcomes'] } }));
        expect(result.current.sourcesAllowed).toBe(false);
        expect(result.current.turnFields()).toEqual({ chatSignalsNotice: `agent_public@${VERSION}` });
        act(() => result.current.applyEmbedPayload({ showSources: true }));
        expect(result.current.sourcesAllowed).toBe(true);
        expect(result.current.turnFields()).toEqual({});
    });

    it('adds the opt-out once the visitor chose it', () => {
        const { result } = renderHook(() => useEmbedVisitorState());
        act(() => result.current.applyEmbedPayload({ complianceNotice: { state: 'scheduled', from: '2026-10-14', version: VERSION } }));
        act(() => result.current.setDontCount(true));
        expect(result.current.turnFields()).toEqual({ chatSignalsNotice: `agent_public@${VERSION}`, chatSignalsOptOut: true });
    });
});
