/**
 * Come back online → drain the outbox.
 *
 * The common failure is a recording finished in a basement meeting room with
 * no signal. Retrying by hand works, but the person who most needs this is the
 * one who has already put their phone away.
 */

import NetInfo from '@react-native-community/netinfo';
import { useEffect, useRef } from 'react';

import { useOutbox } from '../model/outbox';
import type { TranscriptionAccepted } from '../model/types';

export function useDrainOnReconnect(onAccepted: (note: TranscriptionAccepted) => void) {
    const items = useOutbox((state) => state.items);
    const uploadAll = useOutbox((state) => state.uploadAll);
    const queuedCount = items.filter((item) => item.status !== 'uploading').length;
    const wasOffline = useRef(false);

    useEffect(() => {
        const unsubscribe = NetInfo.addEventListener((state) => {
            const online = Boolean(state.isConnected) && state.isInternetReachable !== false;
            if (!online) {
                wasOffline.current = true;
                return;
            }
            if (wasOffline.current && queuedCount > 0) {
                wasOffline.current = false;
                void uploadAll(onAccepted);
            }
            wasOffline.current = false;
        });
        return unsubscribe;
    }, [queuedCount, uploadAll, onAccepted]);
}
