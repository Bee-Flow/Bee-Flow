/**
 * Pairing with Nextcloud: run Login Flow v2 and hand the credential to the
 * Bee Flow server.
 *
 * This is the point of the pairing: the server already knows how to read
 * Nextcloud files (server/integrations/nextcloudFiles/), it just needs a
 * credential. Everything with side effects — the login flow, the OS keyring,
 * the request to the server — is injected, so the order of the steps and
 * what each outcome means can be tested on their own.
 */

import { CLIENT_HEADER, CLIENT_KIND } from '../security/sessionHeaders.ts';
import { serverUrl as joinServerUrl } from '../server/url.ts';
import { INVALID_NEXTCLOUD_ADDRESS, parseNextcloudUrl } from './address.ts';
import type { LoginFlowCredential } from './loginFlow.ts';

export type PairingResult = { ok: true; server: string; loginName: string; storedOnServer: boolean } | { ok: false; error: string };

export interface PairingLog {
    info(scope: string, message: string): void;
    warn(scope: string, message: string): void;
}

export interface PairingDeps {
    /** Run the login flow against this Nextcloud. */
    login: (target: string) => Promise<LoginFlowCredential>;
    /** Keep the app password in the OS keyring; false when that is not possible. */
    persistAppPassword: (appPassword: string) => Promise<boolean>;
    /** Hand the credential to the Bee Flow server; true when it stored it. */
    sendToServer: (credential: LoginFlowCredential) => Promise<boolean>;
    log: PairingLog;
}

export const NO_PAIRING_TARGET = 'Bee Flow does not know which Nextcloud to sign in to.';

export { INVALID_NEXTCLOUD_ADDRESS, parseNextcloudUrl };

export type PairingTarget = { ok: true; url: string; source: 'hint' | 'desktop-client' | 'saved' | 'server' } | { ok: false; error: string };

export const INVALID_PAIRING_ADDRESS = INVALID_NEXTCLOUD_ADDRESS;

/**
 * The Nextcloud to pair with, in order: the address asked for, the first
 * account the Nextcloud desktop client knows, the address saved in Settings,
 * the Nextcloud the user's own
 * Bee Flow server is connected to. An address asked for that is not usable is
 * an error, not a reason to quietly pick another one.
 */
export async function resolvePairingTarget(
    hint: string | undefined,
    accounts: readonly { url: string }[],
    saved: string,
    fromServer: () => Promise<string | null>,
): Promise<PairingTarget> {
    if (hint?.trim()) {
        const url = parseNextcloudUrl(hint);
        return url ? { ok: true, url, source: 'hint' } : { ok: false, error: INVALID_PAIRING_ADDRESS };
    }
    for (const account of accounts) {
        const url = parseNextcloudUrl(account.url);
        if (url) return { ok: true, url, source: 'desktop-client' };
    }
    const savedUrl = parseNextcloudUrl(saved);
    if (savedUrl) return { ok: true, url: savedUrl, source: 'saved' };
    const url = parseNextcloudUrl(await fromServer().catch(() => null));
    return url ? { ok: true, url, source: 'server' } : { ok: false, error: NO_PAIRING_TARGET };
}

export async function pairNextcloud(target: string, deps: PairingDeps): Promise<PairingResult> {
    if (!target) {
        return { ok: false, error: NO_PAIRING_TARGET };
    }
    try {
        const credential = await deps.login(target);
        // The password is held in the OS keyring so the app can re-present
        // it after a server rebuild without another round trip.
        const persisted = await deps.persistAppPassword(credential.appPassword);
        if (!persisted) deps.log.warn('Nextcloud', 'the app password is held for this session only');

        const storedOnServer = await deps.sendToServer(credential);
        deps.log.info('Nextcloud', `linked ${credential.loginName} at ${credential.server}`);
        return { ok: true, server: credential.server, loginName: credential.loginName, storedOnServer };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.log.warn('Nextcloud', `pairing failed: ${message}`);
        return { ok: false, error: message };
    }
}

/** The part of `fetch` the hand-over needs; the main window's session provides it. */
export type SessionFetch = (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json?: () => Promise<unknown> }>;

/**
 * Hand the app password to the user's own Bee Flow server.
 *
 * The request rides the main window's session, so it carries the user's
 * existing sign-in and no separate token is needed.
 */
export async function sendAppPasswordToServer(credential: LoginFlowCredential, base: string, fetch: SessionFetch, log: Pick<PairingLog, 'warn'>): Promise<boolean> {
    try {
        const response = await fetch(joinServerUrl(base, '/auth/save-app-password'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', [CLIENT_HEADER]: CLIENT_KIND },
            body: JSON.stringify({ username: credential.loginName, password: credential.appPassword, url: credential.server }),
        });
        if (!response.ok) {
            log.warn('Nextcloud', `the Bee Flow server refused the app password (HTTP ${response.status})`);
            return false;
        }
        return true;
    } catch (error) {
        log.warn('Nextcloud', `could not reach the Bee Flow server to store the app password: ${String(error)}`);
        return false;
    }
}

/**
 * The Nextcloud the user's own Bee Flow server is connected to: the address on
 * their saved app password. Null when there is none or the server cannot say.
 */
export async function fetchServerNextcloudUrl(base: string, fetch: SessionFetch, log: Pick<PairingLog, 'warn'>): Promise<string | null> {
    try {
        const response = await fetch(joinServerUrl(base, '/auth/app-password-status'), {
            method: 'GET',
            headers: { [CLIENT_HEADER]: CLIENT_KIND },
        });
        if (!response.ok || !response.json) return null;
        const body = await response.json();
        const url = body && typeof body === 'object' ? (body as { nextcloudUrl?: unknown }).nextcloudUrl : null;
        return typeof url === 'string' && url ? url : null;
    } catch (error) {
        log.warn('Nextcloud', `could not ask the Bee Flow server for its Nextcloud: ${String(error)}`);
        return null;
    }
}
