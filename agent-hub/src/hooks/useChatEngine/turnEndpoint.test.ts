import { describe, expect, it } from 'vitest';
import { DIRECT_TURN_PATH, chatSignalsSurfaceFor, resolveTurnEndpoint } from './turnEndpoint';

describe('resolveTurnEndpoint', () => {
    it('direct mode posts to the direct stream unless a custom endpoint is set', () => {
        expect(resolveTurnEndpoint({ isDirectMode: true })).toBe('/ai/chat/direct/stream');
        expect(resolveTurnEndpoint({ isDirectMode: true, customEndpoint: '/ai/chat/webpage/stream' })).toBe('/ai/chat/webpage/stream');
    });

    it('agent mode posts to the agent stream', () => {
        expect(resolveTurnEndpoint({ isDirectMode: false, agentId: 'a1' })).toBe('/agents/a1/chat/stream');
    });
});

describe('chatSignalsSurfaceFor', () => {
    it('the direct stream is the direct chat type', () => {
        expect(chatSignalsSurfaceFor(DIRECT_TURN_PATH)).toBe('direct');
        expect(chatSignalsSurfaceFor(resolveTurnEndpoint({ isDirectMode: true }))).toBe('direct');
    });

    it('the agent stream is the agent chat type', () => {
        expect(chatSignalsSurfaceFor('/agents/a1/chat/stream')).toBe('agent');
        expect(chatSignalsSurfaceFor(resolveTurnEndpoint({ isDirectMode: false, agentId: 'abc-123' }))).toBe('agent');
    });

    it('webpage, template, notebook and custom endpoints are no chat type at all', () => {
        for (const path of [
            '/ai/chat/webpage/stream',
            '/ai/chat/template/stream',
            '/ai/notebooks/n1/chat/stream',
            '/ai/chat/direct/stream?x=1',
            '/ai/chat/direct/stream/extra',
            '/agents/a1/chat',
            '/agents/a1/chat/stream/more',
            '/agents//chat/stream',
            '',
            null,
            undefined,
        ]) {
            expect(chatSignalsSurfaceFor(path), String(path)).toBeNull();
        }
    });
});
