import { describe, it, expect, vi } from 'vitest';
import { dispatchSSEEvent } from '../dispatch';
import type { SseDispatchContext, SseDispatchIds, SseEventData } from '../../types';

const ids = { assistantMsgId: 'a', activeIdRef: { current: 'a' } } as unknown as SseDispatchIds;
const ctx = { setMessages: () => {} } as unknown as SseDispatchContext;
const send = (data: Record<string, unknown>) => dispatchSSEEvent(ctx, 'document_open', data as SseEventData, ids);
const detailOf = (fn: ReturnType<typeof vi.fn>) => (fn.mock.calls[0][0] as CustomEvent<{ id: string }>).detail;

describe('document_open', () => {
    it('becomes the beeflow:open-document-side DOM event', () => {
        const seen = vi.fn();
        window.addEventListener('beeflow:open-document-side', seen);
        send({ documentId: 'd1', name: 'a.xlsx', docType: 'spreadsheet' });
        window.removeEventListener('beeflow:open-document-side', seen);
        expect(seen).toHaveBeenCalledTimes(1);
        expect(detailOf(seen).id).toBe('d1');
    });

    it('ignores a payload without a string documentId', () => {
        const seen = vi.fn();
        window.addEventListener('beeflow:open-document-side', seen);
        send({ name: 'a.xlsx' });
        send({ documentId: 5 });
        window.removeEventListener('beeflow:open-document-side', seen);
        expect(seen).not.toHaveBeenCalled();
    });
});
