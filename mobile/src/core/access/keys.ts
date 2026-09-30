/**
 * Query keys for the access answers. Keyed by user, so a different person on
 * the same phone can never read the last one's entitlements; AuthProvider
 * invalidates the whole root whenever a session enters the signed-in stage,
 * and sign-out clears the query cache outright.
 *
 * Deliberately import-free: core/auth imports this file, and this package's
 * hooks import core/auth.
 */

export const accessKeys = {
    all: ['access'] as const,
    entitlements: (userId: string) => ['access', 'entitlements', userId] as const,
    license: (userId: string) => ['access', 'license', userId] as const,
};
