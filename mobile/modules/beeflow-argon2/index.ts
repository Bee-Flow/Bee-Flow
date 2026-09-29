/**
 * The JS face of the native Argon2id module.
 *
 * Deliberately thin and deliberately optional. `nativeArgon2id` returns null
 * when the native module is not present — an Expo Go session, a build where
 * autolinking did not pick the module up, a platform that is not Android — and
 * the caller falls back to the pure-JS implementation rather than failing.
 * See src/crypto/opaque/ksf.ts for the verification that gates its use.
 */

import { requireOptionalNativeModule } from 'expo';

interface BeeFlowArgon2Native {
    argon2id(
        passwordBase64: string,
        saltBase64: string,
        iterations: number,
        memoryKiB: number,
        parallelism: number,
        outputLength: number,
    ): Promise<string>;
}

const native = requireOptionalNativeModule<BeeFlowArgon2Native>('BeeFlowArgon2');

export const isNativeArgon2Available = native !== null;

/**
 * Run Argon2id natively. Inputs and the result are standard base64.
 * Returns null when there is no native module to run it on.
 */
export async function nativeArgon2id(
    passwordBase64: string,
    saltBase64: string,
    params: {
        iterations: number;
        memoryKiB: number;
        parallelism: number;
        outputLength: number;
    },
): Promise<string | null> {
    if (!native) return null;
    return native.argon2id(
        passwordBase64,
        saltBase64,
        params.iterations,
        params.memoryKiB,
        params.parallelism,
        params.outputLength,
    );
}
