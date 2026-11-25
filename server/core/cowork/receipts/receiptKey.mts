/**
 * The key that signs Cowork run receipts: one Ed25519 key pair per installation, made the first time a receipt is
 * signed. The private half is a secret in the config store, sealed there under a key derived from
 * MASTER_ENCRYPTION_KEY (stores/configEncryption.js); when two replicas make one at the same moment, the one stored
 * first wins and both use it. The public half can be handed to anyone who wants to check a receipt outside Bee Flow.
 *
 * What a signature proves, and what not: a receipt signed with this key was issued by this installation and has not
 * changed since. It does not protect against someone who holds both the database and the master key: they can sign
 * too. Without a master key there is no sealed secret, and receipts are issued unsigned (their chain still holds).
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../../telemetry/log.js') as { warn: (m: string) => void };

export const RECEIPT_KEY_NAME = 'cowork_receipt_signing_key';

export interface SecretStore {
    getSecret: (key: string) => Promise<string | null>;
    setSecretIfAbsent: (key: string, value: string) => Promise<string | null>;
}

export interface ReceiptKey { keyId: string; publicKeyPem: string; privateKeyPem: string }

const store = (): SecretStore => nodeRequire('../../../stores/configStore.js') as SecretStore;

/** The id of a public key: the first 16 hex characters of the sha256 of its SPKI form. */
export function keyIdOf(publicKeyPem: string): string {
    const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
    return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

function parseKey(stored: string | null): ReceiptKey | null {
    if (!stored) return null;
    try {
        const k = JSON.parse(stored) as { publicKeyPem?: unknown; privateKeyPem?: unknown };
        if (typeof k.publicKeyPem !== 'string' || typeof k.privateKeyPem !== 'string') return null;
        return { keyId: keyIdOf(k.publicKeyPem), publicKeyPem: k.publicKeyPem, privateKeyPem: k.privateKeyPem };
    } catch {
        return null;
    }
}

let cached: ReceiptKey | null = null;

/** The installation's key, made when there is none; null when no key can be stored (no master key). */
export async function receiptKey(secrets: SecretStore = store()): Promise<ReceiptKey | null> {
    if (cached) return cached;
    try {
        let key = parseKey(await secrets.getSecret(RECEIPT_KEY_NAME));
        if (!key) {
            const pair = generateKeyPairSync('ed25519');
            const fresh = JSON.stringify({
                publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
                privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
            });
            key = parseKey(await secrets.setSecretIfAbsent(RECEIPT_KEY_NAME, fresh));
        }
        cached = key;
        return key;
    } catch (e) {
        log.warn(`[Cowork] no receipt signing key: receipts are issued unsigned (${(e as Error).message})`);
        return null;
    }
}

/** A signature over a receipt's hash, base64url. */
export function signHash(hash: string, key: ReceiptKey): string {
    return sign(null, Buffer.from(hash, 'utf8'), createPrivateKey(key.privateKeyPem)).toString('base64url');
}

/** Does `signature` sign `hash` under this public key? Never throws. */
export function verifyHash(hash: string, signature: string, publicKeyPem: string): boolean {
    try {
        return verify(null, Buffer.from(hash, 'utf8'), createPublicKey(publicKeyPem), Buffer.from(signature, 'base64url'));
    } catch {
        return false;
    }
}

/** Tests: forget the cached key. */
export function _forgetReceiptKey(): void {
    cached = null;
}
