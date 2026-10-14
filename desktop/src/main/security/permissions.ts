/**
 * Which OS permissions a page gets.
 *
 * Chromium asks this process for every one; without handlers it grants most
 * by default. `permissionDecision` (policy.ts) is the rule. On top of it, a
 * server reached over plain http from another machine is asked about per
 * permission: whoever is on that network path can change the page, and the
 * microphone should not go to them unasked.
 *
 * The answers are remembered per origin and permission for the life of the
 * process; the check handler reports only what was allowed.
 */

import { originOf } from '../server/url.ts';

/** The permissions that are asked about on an unencrypted server. */
export const PER_REQUEST: ReadonlySet<string> = new Set(['media', 'audioCapture', 'videoCapture', 'display-capture']);

/** The question put to the person, in the shape `dialog.showMessageBox` takes. */
export interface PermissionPrompt {
    type: 'question';
    buttons: string[];
    defaultId: number;
    cancelId: number;
    title: string;
    message: string;
    detail: string;
}

/** Does this request need the person's answer, rather than the rule alone? */
export function promptNeeded(permission: string, unencrypted: boolean): boolean {
    return unencrypted && PER_REQUEST.has(permission);
}

export function permissionPrompt(url: string, permission: string): PermissionPrompt {
    return {
        type: 'question' as const,
        buttons: ['Block', 'Allow'],
        defaultId: 0,
        cancelId: 0,
        title: 'Allow access?',
        message: `${originOf(url)} wants to use your ${permission === 'display-capture' ? 'screen' : 'microphone or camera'}.`,
        detail: 'This server is reached without encryption, so anyone on the network in between could change the page that is asking. Allow it only on a network you trust.',
    };
}

export interface PermissionDeps {
    /** The policy rule: may this page have this permission at all? */
    allowed: (permission: string, url: string) => boolean;
    /** Is this page the configured server over plain http from another machine? */
    isUnencrypted: (url: string) => boolean;
    onRefused: (permission: string, url: string) => void;
}

export interface PermissionHandlers {
    /**
     * Answer a permission request through `callback`; `ask` puts the prompt
     * on screen and resolves to the index of the button chosen (1 = Allow).
     */
    request(permission: string, url: string, ask: (prompt: PermissionPrompt) => Promise<number>, callback: (granted: boolean) => void): void;
    /** Answer a permission check, synchronously. */
    check(permission: string, requestingOrigin: string): boolean;
}

export function createPermissionHandlers(deps: PermissionDeps): PermissionHandlers {
    const asked = new Map<string, boolean>();
    return {
        request(permission, url, ask, callback) {
            if (!deps.allowed(permission, url)) {
                deps.onRefused(permission, url);
                callback(false);
                return;
            }
            if (!promptNeeded(permission, deps.isUnencrypted(url))) {
                callback(true);
                return;
            }
            const key = `${originOf(url)} ${permission}`;
            const previous = asked.get(key);
            if (previous !== undefined) {
                callback(previous);
                return;
            }
            void ask(permissionPrompt(url, permission)).then((response) => {
                asked.set(key, response === 1);
                callback(response === 1);
            });
        },
        check(permission, requestingOrigin) {
            if (!deps.allowed(permission, requestingOrigin)) return false;
            if (promptNeeded(permission, deps.isUnencrypted(requestingOrigin))) return asked.get(`${originOf(requestingOrigin)} ${permission}`) === true;
            return true;
        },
    };
}
