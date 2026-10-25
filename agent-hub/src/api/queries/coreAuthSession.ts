// The session reads and the logout call behind AuthedApp's boot, login and
// logout. Thin on purpose: each returns the raw Response (or rejects) exactly
// as authFetch does, because the callers decide what a non-ok answer or a
// network failure means (the boot path treats them differently).

import { API_BASE, authFetch } from '../../utils/helpers';

/** GET /auth/setup-status (available without a session). */
export function fetchSetupStatus(): Promise<Response> {
    return authFetch(`${API_BASE}/auth/setup-status`);
}

/** GET /auth/user, never from the HTTP cache (the NC onboarding flag flips server-side). */
export function fetchAuthUser(): Promise<Response> {
    return authFetch(`${API_BASE}/auth/user`, { cache: 'no-store' });
}

/** GET /auth/my-permissions. */
export function fetchMyPermissions(): Promise<Response> {
    return authFetch(`${API_BASE}/auth/my-permissions`);
}

/** GET the connector's bootstrap diagnostics (admin-only; 404s in standalone mode). */
export function fetchSetupDiagnostics(): Promise<Response> {
    return authFetch(`${API_BASE}/setup/diagnostics`, { cache: 'no-store' });
}

/** POST /auth/logout. */
export function postLogout(): Promise<Response> {
    return authFetch(`${API_BASE}/auth/logout`, { method: 'POST' });
}
