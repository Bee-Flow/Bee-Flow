/**
 * The effects that keep a session honest while the app lives: a 401 anywhere
 * resets it, returning to the foreground renews the token (and relocks after a
 * long absence), and a signed-in phone renews its token on a timer. Split out
 * of AuthProvider, which owns the state these act on.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { setUnauthorizedHandler } from '@/core/api/client';
import { getServerUrl } from '@/core/api/server';
import { clearSessionCache } from '@/core/api/sessionCache';

import { clearSessionToken, primeSessionToken, renewIfStale, REFRESH_AFTER_MS } from './sessionToken';
import type { AuthStage, User } from './types';
import * as vault from './vault';

/**
 * How long the app may sit in the background before the vault relocks. Zero
 * would relock every time the user opens the camera to attach a photo, which
 * trains people to turn the lock off; two minutes covers the app switches that
 * are part of using the app and not much else.
 */
export const RELOCK_AFTER_MS = 2 * 60_000;

/**
 * A 401 anywhere in the app means the session died under us. `forget` drops
 * what the provider holds for that session (its permissions), so the next
 * sign-in starts from nothing rather than from the previous person's roles.
 */
export function useUnauthorizedReset(resolve: () => Promise<void>, forget: () => void): void {
    const queryClient = useQueryClient();
    useEffect(() => {
        setUnauthorizedHandler(() => {
            vault.lock();
            queryClient.clear();
            clearSessionCache();
            forget();
            // A 401 on a bridged session means the token stands for nothing;
            // keeping it would make every screen fail instead of signing in.
            void clearSessionToken().then(resolve);
        });
        return () => setUnauthorizedHandler(null);
    }, [queryClient, resolve, forget]);
}

interface ForegroundOptions {
    user: User | null;
    stageKind: AuthStage['kind'];
    resolve: () => Promise<void>;
    /** Enter the locked stage for `user`. */
    lockAs: (user: User) => void;
}

/**
 * On every return to the foreground: renew the token (a two-second app switch
 * still ages it), retry an unreachable server (the user walked out of the
 * lift), and relock the vault after RELOCK_AFTER_MS away.
 */
export function useForegroundChecks({ user, stageKind, resolve, lockAs }: ForegroundOptions): void {
    const backgroundedAt = useRef<number | null>(null);
    useEffect(() => {
        const onChange = (next: AppStateStatus) => {
            if (next === 'background' || next === 'inactive') {
                backgroundedAt.current = Date.now();
                return;
            }
            if (next !== 'active') return;
            void primeSessionToken(getServerUrl());
            if (stageKind === 'unreachable') void resolve();
            if (backgroundedAt.current === null) return;
            const away = Date.now() - backgroundedAt.current;
            backgroundedAt.current = null;
            if (away < RELOCK_AFTER_MS) return;
            void (async () => {
                const owner = await vault.persistedOwner();
                if (!owner || !user || owner !== user.id) return;
                vault.lock();
                lockAs(user);
            })();
        };
        const sub = AppState.addEventListener('change', onChange);
        return () => sub.remove();
    }, [user, stageKind, resolve, lockAs]);
}

/**
 * A phone left on one screen for an hour is normal — a meeting recording, a
 * long answer being read. Without this the bridge token would quietly expire
 * underneath it and the next tap would sign the user out.
 */
export function useTokenRenewal(stageKind: AuthStage['kind']): void {
    useEffect(() => {
        if (stageKind !== 'signed-in') return;
        const timer = setInterval(() => {
            void renewIfStale();
        }, REFRESH_AFTER_MS);
        return () => clearInterval(timer);
    }, [stageKind]);
}
