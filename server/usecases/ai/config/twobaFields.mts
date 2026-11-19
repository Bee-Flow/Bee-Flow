/**
 * The 2BA connection fields as the settings form sends them, shared by
 * POST /ai/user-settings (saves them) and POST /ai/twoba/test (tries them
 * unsaved), so a value the test accepts is a value Save accepts.
 *
 * Every field is text; '' (or null) means "not set" / disconnect. The client
 * id and secret are printable ASCII without spaces; the user name and password
 * may hold spaces but no control characters. All of them travel only in the
 * form body of the token call to authorize.2ba.nl, never in a header or a URL.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { z, typeError } = nodeRequire('../../../utils/zod.js') as typeof import('../../../utils/zod.js');

export const MAX_FIELD_CHARS = 256;

/** 1-256 printable ASCII characters without spaces. */
export function isClientValue(value: string): boolean {
    if (value.length === 0 || value.length > MAX_FIELD_CHARS) return false;
    for (let i = 0; i < value.length; i += 1) {
        const c = value.charCodeAt(i);
        if (c <= 0x20 || c >= 0x7f) return false;
    }
    return true;
}

/** 1-256 characters without control characters (spaces allowed). */
export function isAccountValue(value: string): boolean {
    if (value.length === 0 || value.length > MAX_FIELD_CHARS) return false;
    for (let i = 0; i < value.length; i += 1) {
        const c = value.charCodeAt(i);
        if (c < 0x20 || c === 0x7f) return false;
    }
    return true;
}

const field = (ok: (v: string) => boolean, message: string, trim = true) => {
    const base = z.string({ error: typeError({ invalid: message }) });
    return (trim ? base.trim() : base).refine((v) => v === '' || ok(v), message).nullable();
};

export const twobaFields = {
    twobaClientId: field(isClientValue, 'The 2BA client id is invalid. Paste the client id you received from 2BA, with no spaces.'),
    // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- a validation message, not a credential
    twobaClientSecret: field(isClientValue, 'The 2BA client secret is invalid. Paste the client secret you received from 2BA, with no spaces.'),
    twobaAuthMode: z.string({ error: typeError({ invalid: 'The 2BA sign-in is password or authorization_code.' }) }).trim()
        .pipe(z.enum(['', 'password', 'authorization_code'], { error: () => 'The 2BA sign-in is password or authorization_code.' })).nullable(),
    twobaUsername: field(isAccountValue, 'The 2BA user name is invalid (at most 256 characters, no control characters).'),
    // A password keeps its spaces as typed.
    twobaPassword: field(isAccountValue, 'The 2BA password is invalid (at most 256 characters, no control characters).', false),
};
