/**
 * A pure-TypeScript OPAQUE client, wire-compatible with @serenity-kit/opaque
 * v1.1.0 — the library the Bee Flow server authenticates against
 * (`server/auth/opaqueRoutes.js`).
 *
 * Why this exists: @serenity-kit/opaque is WebAssembly and cannot run on Hermes,
 * and the only React Native binding for opaque-ke has been unmaintained since
 * 2023 (legacy bridge, AGP 7) and does not build against React Native 0.86. So
 * the client half of RFC 9807 is reimplemented here on @noble primitives — no
 * WASM, no native modules, no WebCrypto.
 *
 * The public surface deliberately mirrors @serenity-kit/opaque's `client`
 * namespace so call sites read like the web client's `agent-hub/src/lib/opaque.js`.
 * All values are base64url without padding, which is what the reference library
 * emits and the only encoding it accepts (see `serde.ts`).
 *
 * ## Sync vs async
 *
 * The reference API is synchronous, and `startRegistration`/`startLogin` here are
 * too — they are sub-millisecond. `finishRegistration` and `finishLogin` run
 * Argon2id at 64 MiB × 3 passes (see `ksf.ts`): ~1.1 s on Node 22 on a laptop,
 * and slower on a phone. Blocking the single JS thread that long freezes touch
 * handling and animations, so **application code should call the `*Async`
 * variants**, which yield to the event loop between Argon2 blocks. The
 * synchronous variants are kept because they are what the interop tests compare
 * against, and because they are the honest signature for code that genuinely
 * cannot await.
 *
 * (Under Jest the same Argon2 call takes ~15 s — a property of Jest's VM sandbox,
 * not of this code or of the Babel config: a bare Jest config with a minimal
 * transform and `testEnvironment: 'node'` is equally slow. That is why
 * `opaque.interop.test.ts` hands the Argon2id primitive to a worker thread
 * outside the sandbox; its header explains the seam.)
 *
 * ## Key hygiene
 *
 * Intermediate key material is zeroed where we still hold the buffer. Values that
 * escape into the returned base64 strings (exportKey, sessionKey) are the
 * caller's to manage, and JS offers no way to erase the immutable copies the
 * engine makes along the way — see `wipe()` in `serde.ts`.
 */

import { finishClientAke, resolveIdentities, startClientAke, type Ke2Parts } from './ake';
import {
    deriveRandomizedPassword,
    recover,
    serializeEnvelope,
    store,
    unmaskResponse,
    type Identifiers,
} from './envelope';
import { stretch, stretchAsync } from './ksf';
import { assertPublicKey, blind, finalize } from './oprf';
import { randomBytes } from './rng';
import {
    ByteReader,
    concatBytes,
    CREDENTIAL_RESPONSE_SIZE,
    decodeFixed,
    KE1_SIZE,
    KE2_SIZE,
    MASKED_RESPONSE_SIZE,
    REGISTRATION_RESPONSE_SIZE,
    SIZES,
    toBase64Url,
    utf8,
    wipe,
} from './serde';

export { OpaqueError } from './serde';
export { KSF_PARAMS } from './ksf';
export type { RandomBytes } from './rng';
export type { Identifiers } from './envelope';

export interface StartRegistrationParams {
    readonly password: string;
}

export interface StartRegistrationResult {
    readonly clientRegistrationState: string;
    readonly registrationRequest: string;
}

export interface FinishRegistrationParams {
    readonly clientRegistrationState: string;
    readonly registrationResponse: string;
    readonly password: string;
    readonly identifiers?: Identifiers;
    /**
     * Called with 0..1 while the key-stretching runs. This is the slowest
     * operation in the app — see ksf.ts — so a caller that has a screen
     * should show it rather than leaving a dead button.
     */
    readonly onProgress?: (fraction: number) => void;
}

export interface FinishRegistrationResult {
    readonly registrationRecord: string;
    readonly exportKey: string;
    readonly serverStaticPublicKey: string;
}

export interface StartLoginParams {
    readonly password: string;
}

export interface StartLoginResult {
    readonly clientLoginState: string;
    readonly startLoginRequest: string;
}

export interface FinishLoginParams {
    readonly clientLoginState: string;
    readonly loginResponse: string;
    readonly password: string;
    readonly identifiers?: Identifiers;
    /**
     * Called with 0..1 while the key-stretching runs. This is the slowest
     * operation in the app — see ksf.ts — so a caller that has a screen
     * should show it rather than leaving a dead button.
     */
    readonly onProgress?: (fraction: number) => void;
}

export interface FinishLoginResult {
    readonly finishLoginRequest: string;
    readonly sessionKey: string;
    readonly exportKey: string;
    readonly serverStaticPublicKey: string;
}

/**
 * Client state is opaque to the server and never leaves the device; the layouts
 * below are ours, not opaque-ke's, and only have to round-trip within this file.
 */
const REGISTRATION_STATE_SIZE = SIZES.SCALAR + SIZES.ELEMENT;
const LOGIN_STATE_SIZE = SIZES.SCALAR + SIZES.SCALAR + KE1_SIZE;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function startRegistration({ password }: StartRegistrationParams): StartRegistrationResult {
    const passwordBytes = utf8(password);
    const { blind: blindScalar, blinded } = blind(passwordBytes, randomBytes);
    wipe(passwordBytes);
    return {
        clientRegistrationState: toBase64Url(concatBytes(blindScalar, blinded)),
        registrationRequest: toBase64Url(blinded),
    };
}

interface RegistrationContext {
    readonly oprfOutput: Uint8Array;
    readonly serverPublicKey: Uint8Array;
}

function registrationOprf(params: FinishRegistrationParams): RegistrationContext {
    const state = decodeFixed(params.clientRegistrationState, REGISTRATION_STATE_SIZE, 'clientRegistrationState');
    const stateReader = new ByteReader(state, 'clientRegistrationState');
    const blindScalar = stateReader.take(SIZES.SCALAR);

    const response = decodeFixed(params.registrationResponse, REGISTRATION_RESPONSE_SIZE, 'registrationResponse');
    const reader = new ByteReader(response, 'registrationResponse');
    const evaluated = reader.take(SIZES.ELEMENT);
    const serverPublicKey = reader.take(SIZES.PUBLIC_KEY);
    // This key is taken on trust (trust-on-registration) and sealed into the
    // envelope's cleartext credentials, so a bad one is not detected here by any
    // MAC — it would surface much later as an unexplainable login failure against
    // a record that can never work. Reject it now, while the error is still local.
    assertPublicKey(serverPublicKey, 'registrationResponse: serverPublicKey');

    const passwordBytes = utf8(params.password);
    const oprfOutput = finalize(passwordBytes, blindScalar, evaluated);
    wipe(passwordBytes, blindScalar, state);
    return { oprfOutput, serverPublicKey };
}

function registrationRecord(
    context: RegistrationContext,
    stretched: Uint8Array,
    identifiers: Identifiers | undefined,
): FinishRegistrationResult {
    const randomizedPassword = deriveRandomizedPassword(context.oprfOutput, stretched);
    wipe(context.oprfOutput, stretched);

    const { envelope, clientPublicKey, maskingKey, exportKey } = store(
        randomizedPassword,
        context.serverPublicKey,
        identifiers,
        randomBytes,
    );
    wipe(randomizedPassword);

    const record = concatBytes(clientPublicKey, maskingKey, serializeEnvelope(envelope));
    const result: FinishRegistrationResult = {
        registrationRecord: toBase64Url(record),
        exportKey: toBase64Url(exportKey),
        serverStaticPublicKey: toBase64Url(context.serverPublicKey),
    };
    wipe(maskingKey, exportKey, record);
    return result;
}

export function finishRegistration(params: FinishRegistrationParams): FinishRegistrationResult {
    const context = registrationOprf(params);
    return registrationRecord(context, stretch(context.oprfOutput), params.identifiers);
}

/** Non-blocking `finishRegistration`; see the module header. */
export async function finishRegistrationAsync(
    params: FinishRegistrationParams,
): Promise<FinishRegistrationResult> {
    const context = registrationOprf(params);
    return registrationRecord(
        context,
        await stretchAsync(context.oprfOutput, params.onProgress),
        params.identifiers,
    );
}

/** Provided for symmetry with the async finish; does no key stretching. */
export async function startRegistrationAsync(
    params: StartRegistrationParams,
): Promise<StartRegistrationResult> {
    return startRegistration(params);
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export function startLogin({ password }: StartLoginParams): StartLoginResult {
    const passwordBytes = utf8(password);
    const { blind: blindScalar, blinded } = blind(passwordBytes, randomBytes);
    wipe(passwordBytes);

    const ake = startClientAke(randomBytes);
    const ke1 = concatBytes(blinded, ake.clientNonce, ake.clientKeyshare);
    return {
        clientLoginState: toBase64Url(concatBytes(blindScalar, ake.ephemeralPrivateKey, ke1)),
        startLoginRequest: toBase64Url(ke1),
    };
}

interface LoginContext {
    readonly oprfOutput: Uint8Array;
    readonly ke1: Uint8Array;
    readonly ke2: Ke2Parts;
    readonly maskingNonce: Uint8Array;
    readonly maskedResponse: Uint8Array;
    readonly ephemeralPrivateKey: Uint8Array;
}

function loginOprf(params: FinishLoginParams): LoginContext {
    const state = decodeFixed(params.clientLoginState, LOGIN_STATE_SIZE, 'clientLoginState');
    const stateReader = new ByteReader(state, 'clientLoginState');
    const blindScalar = stateReader.take(SIZES.SCALAR);
    const ephemeralPrivateKey = stateReader.take(SIZES.SCALAR);
    const ke1 = stateReader.take(KE1_SIZE);

    const ke2Bytes = decodeFixed(params.loginResponse, KE2_SIZE, 'loginResponse');
    // The preamble covers the credential response as one opaque blob, so keep the
    // original bytes rather than re-serializing the fields we split out below.
    const credentialResponse = ke2Bytes.slice(0, CREDENTIAL_RESPONSE_SIZE);
    const reader = new ByteReader(ke2Bytes, 'loginResponse');
    const evaluated = reader.take(SIZES.ELEMENT);
    const maskingNonce = reader.take(SIZES.NONCE);
    const maskedResponse = reader.take(MASKED_RESPONSE_SIZE);
    const serverNonce = reader.take(SIZES.NONCE);
    const serverKeyshare = reader.take(SIZES.PUBLIC_KEY);
    const serverMac = reader.take(SIZES.MAC);

    const passwordBytes = utf8(params.password);
    const oprfOutput = finalize(passwordBytes, blindScalar, evaluated);
    wipe(passwordBytes, blindScalar, state);

    return {
        oprfOutput,
        ke1,
        ke2: {
            credentialResponse,
            serverNonce,
            serverKeyshare,
            serverMac,
        },
        maskingNonce,
        maskedResponse,
        ephemeralPrivateKey,
    };
}

function loginFinish(
    context: LoginContext,
    stretched: Uint8Array,
    identifiers: Identifiers | undefined,
): FinishLoginResult | null {
    const randomizedPassword = deriveRandomizedPassword(context.oprfOutput, stretched);
    wipe(context.oprfOutput, stretched);

    const { serverPublicKey, envelope } = unmaskResponse(
        randomizedPassword,
        context.maskingNonce,
        context.maskedResponse,
    );
    const recovered = recover(randomizedPassword, envelope, serverPublicKey, identifiers);
    wipe(randomizedPassword);
    if (!recovered) {
        // Wrong password. The reference client signals this by returning
        // `undefined`; we return `null` and never throw, which is what
        // `agent-hub/src/lib/opaque.js` and the mobile call sites rely on.
        wipe(context.ephemeralPrivateKey);
        return null;
    }

    const { clientIdentity, serverIdentity } = resolveIdentities(
        identifiers,
        recovered.clientKeyPair.publicKey,
        serverPublicKey,
    );
    const finished = finishClientAke({
        ke1: context.ke1,
        ke2: context.ke2,
        clientIdentity,
        serverIdentity,
        clientEphemeralPrivateKey: context.ephemeralPrivateKey,
        clientStaticPrivateKey: recovered.clientKeyPair.privateKey,
        serverPublicKey,
    });
    wipe(context.ephemeralPrivateKey, recovered.clientKeyPair.privateKey);
    if (!finished) {
        wipe(recovered.exportKey);
        return null;
    }

    const result: FinishLoginResult = {
        finishLoginRequest: toBase64Url(finished.clientMac),
        sessionKey: toBase64Url(finished.sessionKey),
        exportKey: toBase64Url(recovered.exportKey),
        serverStaticPublicKey: toBase64Url(serverPublicKey),
    };
    wipe(finished.sessionKey, recovered.exportKey);
    return result;
}

export function finishLogin(params: FinishLoginParams): FinishLoginResult | null {
    const context = loginOprf(params);
    return loginFinish(context, stretch(context.oprfOutput), params.identifiers);
}

/** Non-blocking `finishLogin`; see the module header. */
export async function finishLoginAsync(params: FinishLoginParams): Promise<FinishLoginResult | null> {
    const context = loginOprf(params);
    return loginFinish(
        context,
        await stretchAsync(context.oprfOutput, params.onProgress),
        params.identifiers,
    );
}

/** Provided for symmetry with the async finish; does no key stretching. */
export async function startLoginAsync(params: StartLoginParams): Promise<StartLoginResult> {
    return startLogin(params);
}

// Re-exported so callers can assert the message sizes they receive.
export { KE1_SIZE, KE2_SIZE, REGISTRATION_RECORD_SIZE, REGISTRATION_REQUEST_SIZE } from './serde';
