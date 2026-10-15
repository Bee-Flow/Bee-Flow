import { describe, it, expect, vi } from 'vitest';
import { dispatchSSEEvent } from '../dispatch';
import type { SseDispatchContext, SseDispatchIds, SseEventData } from '../../types';

const noop = () => {};
const ids: SseDispatchIds = {
    assistantMsgId: 'a',
    userMsgId: 'u',
    activeIdRef: { current: 'a' },
    contentRef: { current: '' },
    flusher: { schedule: noop, flushNow: noop, cancel: noop },
    workRef: { current: null },
};
const ctx: SseDispatchContext = {
    setMessages: noop,
    tRef: { current: (key) => key },
    onGammaPreviewRef: { current: undefined },
    onNotebookDocUpdateRef: { current: undefined },
    onNotebookSourceAddedRef: { current: undefined },
    onHistoryLockedRef: { current: undefined },
    onNotebookThemeUpdateRef: { current: undefined },
    onWebpageDocUpdateRef: { current: undefined },
    onWebpageSourceAddedRef: { current: undefined },
    onWebpageExtraUpdateRef: { current: undefined },
    onWebpageExtraDeletedRef: { current: undefined },
};
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
