// "Is anybody looking at this tab?", read from React Query's own focus
// manager instead of a second `visibilitychange` listener per hook.
//
// React Query already pauses a `refetchInterval` while the tab is hidden, but
// it still fetches once on MOUNT — and the polling hooks here were written the
// other way round on purpose: a signed-in user with the app parked in a
// background tab all day is the common case, and a screen that mounts there
// has nobody to show a number to yet. Gating `enabled` on this keeps that
// discipline without any listener of our own: the focus manager owns the one
// subscription, and every hook reads it.

import { focusManager } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

const subscribe = (onChange: () => void) => focusManager.subscribe(() => onChange());
const getSnapshot = () => focusManager.isFocused();
// Server-rendered markup has no tab to be hidden in.
const getServerSnapshot = () => true;

export function useDocumentFocused(): boolean {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
