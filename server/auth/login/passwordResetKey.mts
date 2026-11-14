/**
 * The encryption-key side of an e-mailed password reset (auth/login/passwordResetRoutes.js).
 *
 * A password account's data-encryption key (DEK) is stored wrapped under a key
 * derived from the password (users."wrappedDEK", its salt in "kekSalt",
 * auth/encryptionUserDek.js). A reset replaces the password without the old one,
 * so that wrapping can no longer be opened; left in place, every later sign-in
 * with the new password would be refused (finalizeLogin: no key, no session).
 * What happens to the key follows the organisation's encryption tier:
 *
 *   managed  The DEK also sits in the organisation's escrow ("orgWrappedDEK",
 *            auth/orgEscrow.js), which the server can open. The reset opens it
 *            and wraps the SAME DEK under the new password: the person signs in
 *            and keeps everything. An account without an escrow yet has no
 *            content under its DEK either (on managed, content is keyed to the
 *            escrow, which adopts the sign-in key when it is first made), so
 *            its password wrapping is dropped and the next sign-in creates a
 *            key, as the first sign-in did.
 *   zk       Nobody but the person can open the DEK, and the product promises
 *            that a lost password means lost content. The reset drops the
 *            password wrapping the way an admin reset does
 *            (encryptionUserDek.adminResetUser); the next sign-in creates a
 *            fresh key, and the response tells the person (`encryptionKeyReset`).
 *   none     Nothing is encrypted under the DEK; the wrapping is dropped as on zk.
 *
 * The material returned here is written by the SAME statement as the password
 * hash (stores/user/passwordReset.js), so no row ever holds a new password next
 * to a wrapping the new password cannot open. Pure over its dependencies: the
 * caller hands in the policy lookup, the escrow and the primitives, and a test
 * hands in fakes.
 */

export type Envelope = { iv: string; authTag: string; data: string };

/** The columns of the user row the decision reads (raw row or store shape). */
export type ResetUser = {
    id: string;
    organizationId?: string | null;
    wrappedDEK?: unknown;
    orgWrappedDEK?: string | null;
};

export type ResetKeyMaterial = {
    /** base64 salt of the wrapping under the new password; null drops the wrapping */
    kekSalt: string | null;
    /** JSON envelope of the DEK under the new password; null drops the wrapping */
    wrappedDEK: string | null;
    /** whether what was encrypted for this account stays readable after the reset */
    contentKept: boolean;
};

export type ResetKeyDeps = {
    resolvePolicy: (orgId: string | null | undefined) => Promise<{ tier: string }>;
    /** auth/orgEscrow.unwrapUserDek: the DEK, or null when the envelope does not open */
    unwrapEscrowedDek: (stored: string, orgId: string | null | undefined, userId: string) => Promise<Buffer | null>;
    deriveKEK: (password: string, salt: Buffer) => Promise<Buffer>;
    wrapDEK: (dek: Buffer, kek: Buffer, context: string) => Envelope;
    secureClear: (buf: Buffer) => void;
    randomBytes: (n: number) => Buffer;
    saltLength: number;
};

const MANAGED = 'managed';

const DROPPED: ResetKeyMaterial = Object.freeze({ kekSalt: null, wrappedDEK: null, contentKept: false });

/**
 * The key material the reset writes next to the new password hash, or null
 * when the account holds no password-wrapped key (nothing to re-wrap or drop;
 * the first sign-in after the reset creates one, as for any new account).
 *
 * Throws when the account's escrow exists but cannot be opened: the reset is
 * then refused as a whole (the password stays as it was) instead of leaving an
 * account whose content nobody can reach. That state needs an operator
 * (orgEscrow: a root key that no longer decrypts), not a new password.
 */
export async function keyMaterialForReset(user: ResetUser, newPassword: string, deps: ResetKeyDeps): Promise<ResetKeyMaterial | null> {
    if (!user.wrappedDEK) return null;
    const { tier } = await deps.resolvePolicy(user.organizationId);
    if (tier !== MANAGED) return DROPPED;
    if (!user.orgWrappedDEK) return { kekSalt: null, wrappedDEK: null, contentKept: true };

    const dek = await deps.unwrapEscrowedDek(user.orgWrappedDEK, user.organizationId, user.id);
    if (!dek) {
        throw new Error(`[PasswordReset] the escrowed key of user ${user.id} does not open; the reset is refused so the account keeps its key`);
    }
    const salt = deps.randomBytes(deps.saltLength);
    const kek = await deps.deriveKEK(newPassword, salt);
    try {
        const envelope = deps.wrapDEK(dek, kek, `dek-wrap:${user.id}`);
        return { kekSalt: salt.toString('base64'), wrappedDEK: JSON.stringify(envelope), contentKept: true };
    } finally {
        deps.secureClear(kek);
        deps.secureClear(dek);
    }
}
