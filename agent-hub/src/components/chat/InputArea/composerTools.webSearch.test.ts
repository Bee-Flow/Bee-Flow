import { describe, it, expect, vi } from 'vitest';
import { buildComposerTools } from './composerTools';

const t = (_key: string, en: string) => en;

function webRow(over: Record<string, unknown> = {}) {
    const setWebSearchEnabled = vi.fn();
    const rows = buildComposerTools({
        t, onAttachClick: () => {}, canCreateMedia: false, canPickApps: false,
        canWebSearch: true, webSearchEnabled: true, webSearchBlocked: false, setWebSearchEnabled,
        simpleMode: true, showTierSlider: true, memoryWriteEnabled: true, toggleMemoryWrite: () => {},
        voiceReady: false, voiceMode: false, setVoiceMode: () => {},
        ...over,
    } as Parameters<typeof buildComposerTools>[0]);
    return { row: rows.find((r: { id: string }) => r.id === 'web-search'), setWebSearchEnabled };
}

describe('the Web search row', () => {
    it('is on and usable by default', () => {
        const { row } = webRow();
        expect(row.on).toBe(true);
        expect(row.disabled).toBe(false);
    });

    it('turns off and disabled with the server\'s reason when the route refused it', () => {
        const { row } = webRow({ webSearchUnavailable: 'Web search is not set up on this server' });
        expect(row.on).toBe(false);
        expect(row.dot).toBe(false);
        expect(row.disabled).toBe(true);
        expect(row.hint).toBe('Web search is not set up on this server');
    });

    it('flips the choice the next turn sends', () => {
        const { row, setWebSearchEnabled } = webRow();
        row.onSelect();
        expect(setWebSearchEnabled).toHaveBeenCalledWith(false);
    });
});
