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

import { accessKeys } from '@/core/access/keys';
import { onServerUrlChange, setServerUrl } from '@/core/api/server';
import { clearSessionCache } from '@/core/api/sessionCache';
import { wipeSealed } from '@/core/crypto/sealed';

import { fetchCurrentUser, fetchPermissions, logout as logoutRequest } from './api';
import { resolveSession, withFreshUser } from './session';
import { clearSessionToken } from './sessionToken';
import type { AuthStage, PermissionsResponse, User } from './types';
import { useLoginActions } from './useLoginActions';
import { useForegroundChecks, useTokenRenewal, useUnauthorizedReset } from './useSessionLifecycle';
import * as vault from './vault';

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

/** The stages a fetched permission set belongs to: a session, locked or briefly out of reach. */
const SESSION_KINDS: ReadonlySet<AuthStage['kind']> = new Set(['signed-in', 'locked', 'unreachable']);

export function AuthProvider({ children }: { children: ReactNode }) {
    const [stage, setStage] = useState<AuthStage>({ kind: 'loading' });
    const [permissions, setPermissions] = useState<PermissionsResponse | null>(null);
    const [pendingRecoveryKey, setPendingRecoveryKey] = useState<string | null>(null);
    const queryClient = useQueryClient();
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
    // Permissions describe the session they were fetched for. Outside a
    // session (a 401 reset, a forgotten server, a sign-in in progress) they
    // describe nobody, and the next person's gates must not read the last
    // person's orgRole until /auth/my-permissions answers for them.
    const livePermissions = SESSION_KINDS.has(stageKind) ? permissions : null;
    const forgetPermissions = useCallback(() => setPermissions(null), []);

    /**
     * Fetch the permissions a signed-in stage needs; a failure means none. The
     * entitlement and licence answers (core/access) are re-read at the same
     * moments, so the three gates never describe two different sessions.
     */
    const loadPermissions = useCallback(() => {
        void fetchPermissions().then(setPermissions).catch(() => setPermissions(null));
        void queryClient.invalidateQueries({ queryKey: accessKeys.all });
    }, [queryClient]);

    /**
     * After a sign-in: permissions, plus /auth/user once, because the login
     * answer's user lacks what the gates read (see withFreshUser). A failure
     * keeps the thin user; the next resolve fills it in.
     */
    const onSignedIn = useCallback(() => {
        loadPermissions();
        void fetchCurrentUser()
            .then((me) => setStage((current) => withFreshUser(current, me)))
            .catch(() => undefined);
    }, [loadPermissions]);

    /** Resolve the current session into a stage (see session.ts). */
    const resolve = useCallback(async () => {
        const gen = ++resolveGen.current;
        const next = await resolveSession(() => gen === resolveGen.current);
        if (!next) return;
        setStage(next);
        if (next.kind === 'signed-in') loadPermissions();
    }, [loadPermissions]);

    useEffect(() => {
        // `resolve` sets state only after awaiting the session (session.ts), so
        // nothing here renders synchronously.
        void resolve();
        return onServerUrlChange(() => {
            // Files fetched under the old server's access checks go with it.
            clearSessionCache();
            void resolve();
        });
    }, [resolve]);

    useUnauthorizedReset(resolve, forgetPermissions);
    const lockAs = useCallback((locked: User) => setStage({ kind: 'locked', user: locked }), []);
    useForegroundChecks({ user, stageKind, resolve, lockAs });
    useTokenRenewal(stageKind);

    const { signIn, submitMfaCode, busy, setBusy, keyProgress, error, clearError } = useLoginActions({
        setStage,
        setPendingRecoveryKey,
        onSignedIn,
    });

    const signOut = useCallback(async () => {
        setBusy(true);
        try {
            await logoutRequest();
        } finally {
            await vault.reset();
            // Unsaved edits kept on this phone are the person's own: they go with them.
            await wipeSealed();
            await clearSessionToken();
            queryClient.clear();
            clearSessionCache();
            setPermissions(null);
            setPendingRecoveryKey(null);
            setBusy(false);
            await resolve();
        }
    }, [queryClient, resolve, setBusy]);

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
        await wipeSealed();
        await clearSessionToken();
        queryClient.clear();
        setPermissions(null);
        await setServerUrl(null);
        setStage({ kind: 'needs-server' });
    }, [queryClient]);

    const value = useMemo<AuthContextValue>(
        () => ({
            stage,
            user,
            permissions: livePermissions,
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
            clearError,
        }),
        [
            stage,
            user,
            livePermissions,
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
            clearError,
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
