// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { buildComposerTools, type ComposerTool } from './composerTools';

const t = (_key: string, en: string) => en;

function rowsWith(over: Record<string, unknown>, setWebSearchEnabled = vi.fn()) {
    return buildComposerTools({
        t, onAttachClick: () => {}, canCreateMedia: false, canPickApps: false,
        canWebSearch: true, webSearchEnabled: true, webSearchBlocked: false, setWebSearchEnabled,
        simpleMode: true, showTierSlider: true, memoryWriteEnabled: true, toggleMemoryWrite: () => {},
        voiceReady: false, voiceMode: false, setVoiceMode: () => {},
        memoryMode: 'on', changeMemoryMode: () => {},
        ...over,
    } as Parameters<typeof buildComposerTools>[0]).filter(Boolean) as ComposerTool[];
}

function webRow(over: Record<string, unknown> = {}) {
    const setWebSearchEnabled = vi.fn();
    const rows = rowsWith(over, setWebSearchEnabled);
    return { row: rows.find((r) => r.id === 'web-search') as ComposerTool, setWebSearchEnabled };
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
        (row.onSelect as () => void)();
        expect(setWebSearchEnabled).toHaveBeenCalledWith(false);
    });
});

describe('in an incognito chat', () => {
    it('keeps the attach row, inert, with the reason as its hint', () => {
        const attach = rowsWith({ incognito: true }).find((r) => r.id === 'attach');
        expect(attach).toMatchObject({ disabled: true, hint: 'Attachments are off in an incognito chat: a file would have to be stored to be read.' });
        expect(rowsWith({}).find((r) => r.id === 'attach')?.disabled).toBeUndefined();
    });

    it('shows memory locked off with the incognito reason', () => {
        const memory = rowsWith({ showTierSlider: false, simpleMode: false, memoryLock: 'incognito' }).find((r) => r.id === 'memory');
        expect(memory).toMatchObject({ on: false, disabled: true, hint: 'Memory is off in an incognito chat: nothing is read or saved.' });
    });
});
