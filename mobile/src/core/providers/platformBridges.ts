/**
 * The platform signals React Query and the HTTP client need, which their web
 * defaults do not provide in React Native: "are we online" (NetInfo) and "is
 * the app focused" (AppState).
 */

import NetInfo from '@react-native-community/netinfo';
import { focusManager, onlineManager } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { setConnectivity } from '@/core/api/client';

let installed = false;

/**
 * Bridge NetInfo into React Query's onlineManager and into the HTTP client, so
 * a request that fails while there is no network is reported as being offline
 * rather than as a server fault. A captive portal counts as offline: connected,
 * but nothing reachable. Call once, at module scope of the root layout.
 */
export function installNetworkBridges(): void {
    if (installed) return;
    installed = true;
    onlineManager.setEventListener((setOnline) =>
        NetInfo.addEventListener((state) => setOnline(Boolean(state.isConnected))),
    );
    NetInfo.addEventListener((state) =>
        setConnectivity(Boolean(state.isConnected) && state.isInternetReachable !== false),
    );
}

/** Tell React Query the app is focused exactly when Android says it is active. */
export function useAppStateFocus(): void {
    useEffect(() => {
        const handler = (status: AppStateStatus) => focusManager.setFocused(status === 'active');
        const sub = AppState.addEventListener('change', handler);
        return () => sub.remove();
    }, []);
}
