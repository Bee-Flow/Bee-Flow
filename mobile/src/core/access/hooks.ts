/**
 * The access hooks: what a screen asks to decide what to OFFER. The server
 * authorises every call on its own; these keep guaranteed-403 doors off the
 * screen (see model/gate.ts for hide vs. lock).
 *
 * Two weights. `useAccess` and the hooks built on it mount the entitlement
 * and licence queries (shared, cached five minutes, keyed by user, fetched
 * only in the signed-in stage). The role and permission hooks read core/auth
 * alone and mount no query at all.
 */

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useAuth } from '@/core/auth/AuthProvider';

import { fetchEntitlements, fetchLicenseInfo } from './api';
import { accessKeys } from './keys';
import { compileEntitlements } from './model/entitlements';
import { evaluateGate, type Gate, type GateResult } from './model/gate';
import { buildAccessSnapshot, can, canUse, hasLicenseFeature, holds, holdsAny, type Source } from './model/snapshot';
import type { AccessSnapshot, CompiledEntitlements, Entitlements, LicenseInfo } from './model/types';

/** Grants change when an admin changes them, not per screen. */
const STALE_MS = 5 * 60_000;

/**
 * A payload with no body, or a degraded resolver, says nothing. Module-level
 * so react-query's `select` memoises it: the lookups are built once per answer.
 */
function compile(data: Entitlements | null): CompiledEntitlements | null {
    return data && !data.degraded ? compileEntitlements(data) : null;
}

interface QueryLike<T> {
    data: T | null | undefined;
    isPending: boolean;
}

/**
 * Data wins, even beside a failed refetch (the last good answer still holds);
 * a settled query with nothing is unavailable; otherwise it is still loading.
 * A disabled query stays pending, and reads as loading.
 */
export function sourceOf<T>(query: QueryLike<T>): Source<T> {
    if (query.data) return { state: 'ready', data: query.data };
    if (!query.isPending) return { state: 'unavailable', data: null };
    return { state: 'loading', data: null };
}

/*
 * The sources and the snapshot are memoised on the query's DATA and state,
 * never on the query result: useQuery hands back a new tracking Proxy on every
 * render, so anything keyed on it was rebuilt every time — and a new snapshot
 * re-rendered every gated row under it (the drawer, on every navigation).
 */

function useEntitlementsSource(userId: string | null): Source<CompiledEntitlements> {
    const { data, isPending } = useQuery({
        queryKey: accessKeys.entitlements(userId ?? ''),
        queryFn: ({ signal }) => fetchEntitlements(signal),
        select: compile,
        enabled: userId !== null,
        staleTime: STALE_MS,
    });
    return useMemo(() => sourceOf({ data, isPending }), [data, isPending]);
}

function useLicenseSource(userId: string | null): Source<LicenseInfo> {
    const { data, isPending } = useQuery({
        queryKey: accessKeys.license(userId ?? ''),
        queryFn: ({ signal }) => fetchLicenseInfo(signal),
        enabled: userId !== null,
        staleTime: STALE_MS,
    });
    return useMemo(() => sourceOf({ data, isPending }), [data, isPending]);
}

/** Everything a gate is decided on: roles, permissions, entitlements, licence. The same object until one changes. */
export function useAccess(): AccessSnapshot {
    const { stage, user, permissions } = useAuth();
    const activeUserId = stage.kind === 'signed-in' ? stage.user.id : null;
    const entitlements = useEntitlementsSource(activeUserId);
    const license = useLicenseSource(activeUserId);
    return useMemo(
        () => buildAccessSnapshot({ user, permissions, entitlements, license }),
        [user, permissions, entitlements, license],
    );
}

/** Roles and permissions only; no query is mounted. */
function usePersonAccess(): AccessSnapshot {
    const { user, permissions } = useAuth();
    return useMemo(() => buildAccessSnapshot({ user, permissions }), [user, permissions]);
}

/** EntitlementsContext.can: the capability (or licence feature) is effective. */
export function useCan(id: string): boolean {
    return can(useAccess(), id);
}

/** LicenseContext.hasFeature (see model/snapshot.hasLicenseFeature). */
export function useHasLicenseFeature(id: string): boolean {
    return hasLicenseFeature(useAccess(), id);
}

/** The server's canUseFeature map, with the web's makeCanUse fallback. */
export function useCanUse(id: string): boolean {
    return canUse(usePersonAccess(), id);
}

/** Holds `id` or `all`, or is a super admin. */
export function useHasPermission(id: string): boolean {
    return holds(usePersonAccess(), id);
}

/** Holds at least one of `ids`. */
export function useHasAnyPermission(...ids: string[]): boolean {
    return holdsAny(usePersonAccess(), ids);
}

/** The server's org-admin predicate (model/roles.isOrgAdmin). */
export function useIsOrgAdmin(): boolean {
    return usePersonAccess().isOrgAdmin;
}

/** The platform operator (model/roles.isSuperAdmin). */
export function useIsSuperAdmin(): boolean {
    return usePersonAccess().isSuperAdmin;
}

/** The verdict for one declarative gate: visible, locked, and why. */
export function useGate(gate: Gate): GateResult {
    return evaluateGate(gate, useAccess());
}
