/**
 * The sign-in state machine.
 *
 * The web app can be sloppy here — a 401 reloads the page and the router sorts
 * it out. On a phone that would discard unsent input and any in-flight
 * recording, so the stage below is explicit and every transition is deliberate.
 *
 * Stages map one-to-one onto screens (see app/_layout.tsx); adding a stage
 * means adding a screen, which is the point: the server has eight different
 * "you are not in yet" answers and each of them needs its own thing said.
 */

import { useQueryClient } from '@tanstack/react-query';
import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';


import {
    fetchCurrentUser,
    fetchPermissions,
    InvalidCredentialsError,
    logout as logoutRequest,
    opaqueLogin,
    passwordLogin,
    verifyMfaLogin,
} from './api';
import { serverAnsweredAboutSession } from './reachability';
import {
    clearSessionToken,
    primeSessionToken,
    renewIfStale,
    REFRESH_AFTER_MS,
} from './sessionToken';
import type { AuthStage, PermissionsResponse, User } from './types';
import * as vault from './vault';
import { setUnauthorizedHandler } from '../api/client';
import { getServerUrl, loadServerUrl, onServerUrlChange, setServerUrl } from '../api/server';

interface AuthContextValue {
    stage: AuthStage;
    user: User | null;
    permissions: PermissionsResponse | null;
    /**
     * Shown once, immediately after the server minted or migrated the DEK.
     * The user can never see it again, so it is held here until acknowledged
     * rather than being rendered inline and lost on a re-render.
     */
    pendingRecoveryKey: string | null;
    acknowledgeRecoveryKey: () => void;

    signIn: (username: string, password: string) => Promise<void>;
    submitMfaCode: (code: string) => Promise<void>;
    signOut: () => Promise<void>;
    /** Re-read /auth/user — after encryption setup, approval, verification. */
    refresh: () => Promise<void>;
    chooseServer: (url: string) => Promise<void>;
    forgetServer: () => Promise<void>;
    unlock: () => Promise<boolean>;
    /** True while a sign-in request is in flight. */
    busy: boolean;
    /**
     * 0..1 while the OPAQUE key-stretching runs, otherwise null. Surfaced so
     * the sign-in screen can show a determinate bar for the one step that
     * takes seconds rather than milliseconds.
     */
    keyProgress: number | null;
    error: string | null;
    clearError: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * How long the app may sit in the background before the vault relocks.
 *
 * Zero would relock every time the user opens the camera to attach a photo,
 * which trains people to turn the lock off. Two minutes covers the app
 * switches that are part of using the app and not much else.
 */
const RELOCK_AFTER_MS = 2 * 60_000;

export function AuthProvider({ children }: { children: ReactNode }) {
    const [stage, setStage] = useState<AuthStage>({ kind: 'loading' });
    const [permissions, setPermissions] = useState<PermissionsResponse | null>(null);
    const [pendingRecoveryKey, setPendingRecoveryKey] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [keyProgress, setKeyProgress] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const queryClient = useQueryClient();
    const backgroundedAt = useRef<number | null>(null);
    /**
     * Which resolve is allowed to speak.
     *
     * There are now four things that can start one — boot, the server-URL
     * listener, the 401 handler, and (new) the unreachable screen's retry timer
     * plus the foreground handler — so overlapping runs stopped being
     * theoretical. Without this, a slow resolve that ends in "unreachable" can
     * land AFTER a later one that reached "signed-in" and throw a signed-in
     * user back out of the app.
     */
    const resolveGen = useRef(0);

    const user = 'user' in stage ? stage.user : null;
    // Effects below depend on WHICH stage, never on its payload; naming that
    // keeps a new user object from re-arming the timer on every resolve.
    const stageKind = stage.kind;

    /** Resolve the current session into a stage. */
    const resolve = useCallback(async () => {
        const gen = ++resolveGen.current;
        /** False once a newer resolve has started; a stale run must stay quiet. */
        const current = () => gen === resolveGen.current;

        const server = await loadServerUrl();
        if (!current()) return;
        if (!server) {
            setStage({ kind: 'needs-server' });
            return;
        }
        // Before anything is fetched. An SSO session authenticates by header,
        // so a cold start whose first request goes out without the token reads
        // as signed-out and the app throws the session away for no reason.
        await primeSessionToken(server);
        try {
            const me = await fetchCurrentUser();
            if (!current()) return;
            if (!me.authenticated || !me.user) {
                // The server has answered that nobody is signed in, so any
                // token we are still holding stands for nothing. Keeping it
                // would put a dead credential on every subsequent request and,
                // worse, silently override a cookie sign-in made after this.
                await clearSessionToken();
                if (!current()) return;
                setStage({
                    kind: 'signed-out',
                    oauthProviders: me.oauthProviders ?? [],
                    isOAuthConfigured: Boolean(me.isOAuthConfigured),
                });
                return;
            }
            // Encryption gates come before anything else the app can show:
            // without a DEK, most of the product returns ciphertext.
            if (me.needsEncryptionSetup) return setStage({ kind: 'encryption-setup-required' });
            if (me.needsEncryptionPin) return setStage({ kind: 'encryption-pin-required' });

            // A session can outlive the process. If the vault is empty but a
            // key is stored behind biometrics for this user, ask for a
            // fingerprint rather than a password.
            if (!vault.getDek() && me.encryptionEnabled) {
                const owner = await vault.persistedOwner();
                if (!current()) return;
                if (owner && owner === me.user.id) {
                    setStage({ kind: 'locked', user: me.user });
                    return;
                }
            }

            setStage({ kind: 'signed-in', user: me.user });
            void fetchPermissions().then(setPermissions).catch(() => setPermissions(null));
        } catch (err) {
            // Unreachable server. Not signed out — the session may be perfectly
            // valid — so say so rather than dumping the user at a login form
            // they cannot complete.
            //
            // That comment was already here and the code did the opposite: it
            // set `signed-out`, which IS the login form, for every failure
            // including a five-second tunnel. The session, the cookie and the
            // token were all still on the device and still good; the app just
            // could not ask. `unreachable` says that and retries; only the
            // server actually answering about this session signs anyone out.
            if (!current()) return;
            if (serverAnsweredAboutSession(err)) {
                setStage({ kind: 'signed-out', oauthProviders: [], isOAuthConfigured: false });
                return;
            }
            setStage({ kind: 'unreachable' });
        }
    }, []);

    useEffect(() => {
        // `resolve` awaits loadServerUrl() before it touches state, so nothing
        // is set synchronously and there is no cascading render for the rule to
        // prevent. The lint cannot see across the await. Suppressing it here is
        // narrower than restructuring a function three other call sites rely on
        // (the 401 handler, refresh, and the server picker).
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void resolve();
        return onServerUrlChange(() => {
            void resolve();
        });
    }, [resolve]);

    // A 401 anywhere in the app means the session died under us.
    useEffect(() => {
        setUnauthorizedHandler(() => {
            vault.lock();
            queryClient.clear();
            // A 401 on a bridged session means the token no longer stands for
            // anything. Keeping it would make every screen fail the same way
            // instead of showing the sign-in one.
            void clearSessionToken().then(resolve);
        });
        return () => setUnauthorizedHandler(null);
    }, [queryClient, resolve]);

    // Relock after a spell in the background.
    useEffect(() => {
        const onChange = (next: AppStateStatus) => {
            if (next === 'background' || next === 'inactive') {
                backgroundedAt.current = Date.now();
                return;
            }
            if (next !== 'active') return;
            // Coming back is the moment the token is most likely to be old, and
            // the moment there is time to renew it before the user taps
            // anything. Runs whether or not the app was away long enough to
            // relock — a two-second app switch still ages the token.
            void primeSessionToken(getServerUrl());
            // Returning to the app is also the most likely moment for the
            // network to have come back — the user walked out of the lift, or
            // opened it again once they had signal. Retry rather than leaving
            // them looking at an error they have already fixed.
            if (stageKind === 'unreachable') void resolve();
            if (backgroundedAt.current === null) return;
            const away = Date.now() - backgroundedAt.current;
            backgroundedAt.current = null;
            if (away < RELOCK_AFTER_MS) return;
            void (async () => {
                const owner = await vault.persistedOwner();
                if (!owner || !user || owner !== user.id) return;
                vault.lock();
                setStage({ kind: 'locked', user });
            })();
        };
        const sub = AppState.addEventListener('change', onChange);
        return () => sub.remove();
    }, [user, stageKind, resolve]);

    // A phone left on one screen for an hour is normal — a meeting recording,
    // a long answer being read. Without this the bridge token would quietly
    // expire underneath it and the next tap would sign the user out.
    useEffect(() => {
        if (stageKind !== 'signed-in') return;
        const timer = setInterval(() => {
            void renewIfStale();
        }, REFRESH_AFTER_MS);
        return () => clearInterval(timer);
    }, [stageKind]);

    const applyLoginResult = useCallback(
        async (result: Awaited<ReturnType<typeof passwordLogin>>, username: string) => {
            if (result.recoveryKey) setPendingRecoveryKey(result.recoveryKey);
            if (result.mfaRequired) return setStage({ kind: 'mfa-required', username, methods: result.mfaMethods });
            if (result.mfaSetupRequired) return setStage({ kind: 'mfa-setup-required' });
            if (result.emailVerificationRequired) {
                return setStage({
                    kind: 'email-verification-required',
                    email: username.includes('@') ? username : '',
                });
            }
            if (result.pendingApproval && result.user) {
                return setStage({ kind: 'pending-approval', user: result.user });
            }
            if (result.success && result.user) {
                setStage({ kind: 'signed-in', user: result.user });
                void fetchPermissions().then(setPermissions).catch(() => setPermissions(null));
                return;
            }
            throw new Error(result.error || 'Sign-in failed.');
        },
        [],
    );

    const signIn = useCallback(
        async (username: string, password: string) => {
            setBusy(true);
            setError(null);
            try {
                const first = await passwordLogin(username, password);
                if (first.useOpaque) {
                    // The account moved to OPAQUE. The password above was never
                    // checked — run the real protocol now.
                    const result = await opaqueLogin(username, password, setKeyProgress);
                    if (result.dek) vault.setDek(result.dek);
                    setStage({ kind: 'signed-in', user: result.user });
                    void fetchPermissions().then(setPermissions).catch(() => setPermissions(null));
                    return;
                }
                await applyLoginResult(first, username);
            } catch (err) {
                setError(
                    err instanceof InvalidCredentialsError
                        ? 'Invalid credentials.'
                        : (err as Error)?.message || 'Sign-in failed.',
                );
                throw err;
            } finally {
                setBusy(false);
                setKeyProgress(null);
            }
        },
        [applyLoginResult],
    );

    const submitMfaCode = useCallback(async (code: string) => {
        setBusy(true);
        setError(null);
        try {
            const result = await verifyMfaLogin(code);
            if (result.recoveryKey) setPendingRecoveryKey(result.recoveryKey);
            if (result.success && result.user) {
                setStage({ kind: 'signed-in', user: result.user });
                void fetchPermissions().then(setPermissions).catch(() => setPermissions(null));
                return;
            }
            throw new Error(result.error || 'That code was not accepted.');
        } catch (err) {
            setError((err as Error)?.message || 'That code was not accepted.');
            throw err;
        } finally {
            setBusy(false);
        }
    }, []);

    const signOut = useCallback(async () => {
        setBusy(true);
        try {
            await logoutRequest();
        } finally {
            await vault.reset();
            await clearSessionToken();
            queryClient.clear();
            setPermissions(null);
            setPendingRecoveryKey(null);
            setBusy(false);
            await resolve();
        }
    }, [queryClient, resolve]);

    const unlock = useCallback(async () => {
        const ok = await vault.unlockWithBiometrics();
        if (ok) await resolve();
        return ok;
    }, [resolve]);

    const chooseServer = useCallback(
        async (url: string) => {
            await setServerUrl(url);
            await resolve();
        },
        [resolve],
    );

    const forgetServer = useCallback(async () => {
        await vault.reset();
        await clearSessionToken();
        queryClient.clear();
        await setServerUrl(null);
        setStage({ kind: 'needs-server' });
    }, [queryClient]);

    const value = useMemo<AuthContextValue>(
        () => ({
            stage,
            user,
            permissions,
            pendingRecoveryKey,
            acknowledgeRecoveryKey: () => setPendingRecoveryKey(null),
            signIn,
            submitMfaCode,
            signOut,
            refresh: resolve,
            chooseServer,
            forgetServer,
            unlock,
            busy,
            keyProgress,
            error,
            clearError: () => setError(null),
        }),
        [
            stage,
            user,
            permissions,
            pendingRecoveryKey,
            signIn,
            submitMfaCode,
            signOut,
            resolve,
            chooseServer,
            forgetServer,
            unlock,
            busy,
            keyProgress,
            error,
        ],
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
    return ctx;
}

/**
 * The signed-in user, for screens that only render behind the auth gate.
 * Throws rather than returning null so a screen cannot silently render an
 * empty state when it should never have been reachable.
 */
export function useCurrentUser(): User {
    const { user } = useAuth();
    if (!user) throw new Error('useCurrentUser called outside a signed-in screen');
    return user;
}
