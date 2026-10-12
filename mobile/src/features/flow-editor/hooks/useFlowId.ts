/**
 * The automation id behind a flow key, reactively: the key itself for an automation
 * with no editor open, the draft store's id otherwise — which changes from
 * null to the new id the moment a new automation is created, and re-renders the
 * caller when it does.
 */

import { useSyncExternalStore } from 'react';

import { peekDraftStore } from '../state/registry';

const NOTHING = () => undefined;

export function useFlowId(flowKey: string): string | null {
    const store = peekDraftStore(flowKey);
    return useSyncExternalStore(
        (onChange) => (store ? store.subscribe(onChange) : NOTHING),
        () => (store ? store.getState().automationId : flowKey),
    );
}
