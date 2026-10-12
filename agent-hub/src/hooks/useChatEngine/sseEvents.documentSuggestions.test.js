import { describe, it, expect, vi } from 'vitest';
import { dispatchSSEEvent } from './sseEvents';

describe('document_suggestions', () => {
    it('becomes the beeflow:document-suggestions DOM event', () => {
        const seen = vi.fn();
        window.addEventListener('beeflow:document-suggestions', seen);
        const ids = { assistantMsgId: 'a', activeIdRef: { current: 'a' }, contentRef: { current: '' }, flusher: { flushNow: () => {} }, workRef: { current: null } };
        dispatchSSEEvent({ setMessages: () => {} }, 'document_suggestions', { documentId: 'd1', batchId: 'b1', count: 3 }, ids);
        window.removeEventListener('beeflow:document-suggestions', seen);
        expect(seen).toHaveBeenCalledTimes(1);
        expect(seen.mock.calls[0][0].detail).toEqual({ documentId: 'd1', batchId: 'b1', count: 3 });
    });
});
