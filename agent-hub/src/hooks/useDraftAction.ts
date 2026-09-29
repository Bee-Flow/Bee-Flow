// Confirm/discard logic for the in-chat integration draft cards
// (CalendarDraftCard, ContactsDraftCard, KeepDraftCard). Replaces the
// handleConfirm/handleDiscard pair that was copy-pasted per card:
// `confirm(draft, index)` POSTs the draft to the integration's execute
// endpoint and tracks 'executing' → 'done' / 'failed: …' per draft index;
// `discard(index)` marks that index 'discarded'. The per-index status
// state stays lifted in the caller (MessageItem/index.jsx) so it survives
// card re-mounts, and is passed in as the statuses/setStatuses pair.
// Usage:
//
//   const { confirm, discard, getStatus } = useDraftAction({
//       endpoint: '/api/integrations/calendar/execute',
//       statuses: calendarDraftStatuses,
//       setStatuses: setCalendarDraftStatuses,
//   });
//   const status = getStatus(draft, i);   // statuses[i] || draft.status || 'pending'

import { useCallback } from 'react';
import { API_BASE, authFetch } from '../utils/helpers';

/** 'pending' | 'executing' | 'done' | 'discarded' | `failed: <reason>` — the
 *  failure case carries the server's wording, so this stays a string. */
export type DraftStatus = string;

export type DraftStatusMap = Record<number, DraftStatus>;

/** A draft card's payload; posted verbatim. `status` is the server's own
 *  opinion, used until the user acts on the card. */
export interface DraftLike {
    status?: DraftStatus;
    [key: string]: unknown;
}

export interface UseDraftActionOptions {
    endpoint: string;
    statuses: DraftStatusMap;
    setStatuses: (update: (prev: DraftStatusMap) => DraftStatusMap) => void;
}

export interface UseDraftActionReturn {
    confirm: (draft: DraftLike, index: number) => Promise<void>;
    discard: (index: number) => void;
    getStatus: (draft: DraftLike, index: number) => DraftStatus;
}

export default function useDraftAction(
    { endpoint, statuses, setStatuses }: UseDraftActionOptions,
): UseDraftActionReturn {
    const confirm = useCallback(async (draft: DraftLike, index: number) => {
        setStatuses(prev => ({ ...prev, [index]: 'executing' }));
        try {
            const res = await authFetch(`${API_BASE}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(draft),
            });
            if (res.ok) {
                setStatuses(prev => ({ ...prev, [index]: 'done' }));
            } else {
                const err = await res.json();
                setStatuses(prev => ({ ...prev, [index]: `failed: ${err.error}` }));
            }
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            setStatuses(prev => ({ ...prev, [index]: `failed: ${reason}` }));
        }
    }, [endpoint, setStatuses]);

    const discard = useCallback((index: number) => {
        setStatuses(prev => ({ ...prev, [index]: 'discarded' }));
    }, [setStatuses]);

    const getStatus = useCallback((draft: DraftLike, index: number) => {
        return statuses[index] || draft.status || 'pending';
    }, [statuses]);

    return { confirm, discard, getStatus };
}
