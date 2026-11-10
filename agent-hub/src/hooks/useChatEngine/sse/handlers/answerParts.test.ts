import { describe, expect, it } from 'vitest';

import { dispatchSSEEvent } from '../dispatch';
import type { ChatMessage, KbSource, SseDispatchContext, SseDispatchIds, SseEventData } from '../../types';

/** A one-message conversation the handlers write to, the way the hook's setMessages does. */
function conversation() {
    let messages = [{ id: 'a', role: 'assistant', content: '' }] as unknown as ChatMessage[];
    const setMessages = (update: (prev: ChatMessage[]) => ChatMessage[]) => { messages = update(messages); };
    const ctx = { setMessages } as unknown as SseDispatchContext;
    const ids = { assistantMsgId: 'a', activeIdRef: { current: 'a' } } as unknown as SseDispatchIds;
    return {
        sources: (list: KbSource[]) => dispatchSSEEvent(ctx, 'kb_sources', { sources: list } as SseEventData, ids),
        titles: () => (messages[0].kbSources || []).map(s => s.title),
    };
}

const HEADER = `| product | price | stock |\n| --- | --- | --- |\n${'| filler | 0 | 0 |\n'.repeat(4)}`;

describe('kb_sources — the sources of a later search in the same turn', () => {
    it('keeps a chunk that opens with the same text as one already cited', () => {
        // Every chunk of one table starts with its header row: the first 100
        // characters are identical, the passages are not.
        const c = conversation();
        c.sources([{ title: 'Prices p1', chunkId: 'c1', content: `${HEADER}| bolt | 1 | 9 |` }]);
        c.sources([{ title: 'Prices p2', chunkId: 'c2', content: `${HEADER}| nut | 2 | 4 |` }]);
        expect(c.titles()).toEqual(['Prices p1', 'Prices p2']);
    });

    it('keeps sources that carry no text, live table rows among them', () => {
        const c = conversation();
        c.sources([{ title: 'Row 1', datatableId: 't', rowId: '1', content: '' }]);
        c.sources([{ title: 'Row 2', datatableId: 't', rowId: '2', content: '' }, { title: 'Scan', chunkId: 'c9' }]);
        expect(c.titles()).toEqual(['Row 1', 'Row 2', 'Scan']);
    });

    it('still cites a passage once: the same chunk, the same row, or the same text without an id', () => {
        const c = conversation();
        c.sources([
            { title: 'Doc', chunkId: 'c1', content: 'alpha' },
            { title: 'Row', datatableId: 't', rowId: '1', content: 'x' },
            { title: 'Old', section: 's', content: 'legacy shape' },
        ]);
        c.sources([
            { title: 'Doc again', chunkId: 'c1', content: 'alpha' },
            { title: 'Row again', datatableId: 't', rowId: '1', content: 'edited' },
            { title: 'Old', section: 's', content: 'legacy shape' },
            { title: 'Other', section: 's', content: 'legacy shape' },
        ]);
        expect(c.titles()).toEqual(['Doc', 'Row', 'Old', 'Other']);
    });
});
