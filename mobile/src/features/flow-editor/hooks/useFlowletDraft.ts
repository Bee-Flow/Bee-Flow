/**
 * The routine's draft seen through one of its flowlets (state/scopedStore):
 * the same key, the same row, a store whose definition is the flowlet's and
 * whose edits land in the whole routine. Stable per routine store and key.
 */

import { useMemo } from 'react';

import type { FlowDraft } from './useFlowDraft';
import { scopedDraftStore } from '../state/scopedStore';

export function useFlowletDraft(flow: FlowDraft, key: string | null): FlowDraft {
    const store = useMemo(() => (key ? scopedDraftStore(flow.store, key) : flow.store), [flow.store, key]);
    return store === flow.store ? flow : { ...flow, store };
}
