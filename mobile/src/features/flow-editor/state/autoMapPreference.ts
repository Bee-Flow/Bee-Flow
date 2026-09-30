/**
 * "Auto-map step inputs when connecting" — the web builder's editor
 * preference (SettingsTab's `autoMapOnConnect`, per browser, on unless
 * switched off), kept per device here. It is not part of any routine: it says
 * how THIS person's editor behaves on every routine they build. Held in
 * memory once read, so an insert asks it synchronously.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';

const KEY = 'beeflow.flow.autoMapOnConnect';

let current = true;
let read: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
    for (const l of listeners) l();
}

/** Read the stored choice once; a failed read keeps the default (on). */
export function loadAutoMapPreference(): Promise<void> {
    read ??= AsyncStorage.getItem(KEY)
        .then((stored) => {
            if (stored === '0' && current) {
                current = false;
                emit();
            }
        })
        .catch(() => undefined);
    return read;
}

export function autoMapOnConnect(): boolean {
    return current;
}

export function setAutoMapOnConnect(on: boolean): void {
    if (on !== current) {
        current = on;
        emit();
    }
    void AsyncStorage.setItem(KEY, on ? '1' : '0').catch(() => undefined);
}

export function useAutoMapOnConnect(): [boolean, (on: boolean) => void] {
    useEffect(() => {
        void loadAutoMapPreference();
    }, []);
    const on = useSyncExternalStore(
        (onChange) => {
            listeners.add(onChange);
            return () => listeners.delete(onChange);
        },
        () => current,
    );
    return [on, setAutoMapOnConnect];
}

/** Tests only. */
export function resetAutoMapPreference(): void {
    current = true;
    read = null;
}
