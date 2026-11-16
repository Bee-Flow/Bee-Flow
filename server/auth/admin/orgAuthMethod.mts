/**
 * The organisation's preferred sign-in method (PUT /auth/organizations/:id, ./orgRoutes.js).
 *
 * A preference, not a lock: nothing reads organizations.authMethod when someone signs in
 * (password, Google and Microsoft sign-in work whatever it says), so it may change at any
 * time. It used to be write-once, with copy about keys tied to it that no code ever did; the
 * route kept the first method and dropped every later one while answering 200.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { HttpError } = nodeRequire('../../shared/httpErrors') as { HttpError: new (status: number, code: string, message: string) => Error };

/** The sign-in methods an organisation admin may name as preferred (the signup wizard offers the same three). */
export const PREFERRED_AUTH_METHODS = Object.freeze(['password', 'google', 'microsoft']);

/** Written by the Nextcloud binding (connector/instanceBinding.js) and cleared by unbinding: never an admin's pick. */
const NEXTCLOUD_AUTH_METHOD = 'nextcloud_connector';

/**
 * The value this update writes to the column; undefined leaves it as stored (absent, null, or
 * the stored method again). An unknown method is a 400; a Nextcloud-bound organisation keeps
 * the method its binding wrote (409).
 * @param existing the organisation's row before the change
 * @param authMethod the value from the body
 */
export function preferredAuthMethodUpdate(existing: { authMethod?: string | null } | null | undefined, authMethod: unknown): string | undefined {
    if (authMethod === undefined || authMethod === null) return undefined;
    // The stored value sent back unchanged (a client that sends the whole row) is a no-op,
    // whatever it is, so a Nextcloud-bound organisation can still save its other fields.
    if (existing?.authMethod === authMethod) return undefined;
    if (typeof authMethod !== 'string' || !PREFERRED_AUTH_METHODS.includes(authMethod)) {
        throw new HttpError(400, 'invalid_auth_method', `A sign-in method is one of ${PREFERRED_AUTH_METHODS.join(', ')}.`);
    }
    if (existing?.authMethod === NEXTCLOUD_AUTH_METHOD) {
        throw new HttpError(409, 'auth_method_nextcloud', 'This organisation signs in through its Nextcloud. Unlink the Nextcloud before choosing another method.');
    }
    return authMethod;
}
