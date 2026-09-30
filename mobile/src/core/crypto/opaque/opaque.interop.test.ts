/**
 * Interop suite: this TypeScript client against @serenity-kit/opaque v1.1.0.
 *
 * The reference library is WebAssembly around the Rust `opaque-ke` crate — the
 * exact code the Bee Flow server runs (`server/auth/opaqueRoutes.js`). It is the
 * oracle: every constant in `src/crypto/opaque/` was resolved by testing against
 * it, and these tests are what keep them resolved.
 *
 * The suite is arranged so that a failure localises the drift:
 *
 *  - `serverSetup` layout / OPRF key derivation → the OPRF suite and its context.
 *  - client public key recovered from *their* registration record → the envelope
 *    key expansion and the `OPAQUE-DeriveDiffieHellmanKeyPair` label.
 *  - exportKey agreement → OPRF + envelope + KSF.
 *  - server accepting our KE3 → preamble literal + 3DH transcript.
 *
 * If exportKey matches but the MAC is rejected, the break is in `ake.ts`. If
 * exportKey does not match, it is in `oprf.ts`, `ksf.ts` or `envelope.ts`.
 *
 * ## Argon2id runs outside Jest's VM
 *
 * The KSF (Argon2id, 64 MiB × 3 passes) is ~1.5 s per call in plain Node and
 * ~21 s inside Jest's VM sandbox — not coverage, not Babel; the sandbox alone.
 * At ten calls that was nearly the whole mobile job. So `@noble/hashes/argon2.js`
 * is mocked, and its two functions forward to a worker thread
 * (`opaque.interop.worker.mjs`) that runs the same noble file outside the
 * sandbox. Everything of ours still runs here, under coverage: `ksf.ts` picks
 * the salt and the parameters and chooses between `argon2id` and
 * `argon2idAsync`, and the worker only executes the call it was handed.
 *
 * Two things keep that seam honest. The first describe block checks, on cheap
 * parameters, that the worker's output is bit-identical to the implementation
 * Jest itself loads. And every oracle below compares the worker's full-cost
 * output, through our envelope, with the Rust Argon2 inside the reference.
 */

import { ristretto255, ristretto255_oprf } from '@noble/curves/ed25519.js';
import { argon2id, argon2idAsync } from '@noble/hashes/argon2.js';
import { expand } from '@noble/hashes/hkdf.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { client as refClient, ready as refReady, server as refServer } from '@serenity-kit/opaque';
import { join } from 'node:path';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';

import { buildPreamble } from './ake';
import { deriveRandomizedPassword, recover, unmaskResponse } from './envelope';
import {
    finishLogin,
    finishLoginAsync,
    finishRegistration,
    finishRegistrationAsync,
    KSF_PARAMS,
    OpaqueError,
    startLogin,
    startRegistration,
    type FinishLoginResult,
} from './index';
import { stretch } from './ksf';
import { diffieHellman, finalize } from './oprf';
import { concatBytes, fromBase64, toBase64Url, utf8 } from './serde';
import { __setRandomSourceForTests } from '../random';

// jest.mock is hoisted above the imports, and `ksf.ts` loads noble while they
// run, before `mockArgon2` below exists. So the factory only returns
// forwarders that look it up when they are called.
jest.mock('@noble/hashes/argon2.js', () => ({
    argon2id: (...args: Parameters<typeof mockArgon2.argon2id>) => mockArgon2.argon2id(...args),
    argon2idAsync: (...args: Parameters<typeof mockArgon2.argon2idAsync>) => mockArgon2.argon2idAsync(...args),
}));

type Argon2Module = typeof import('@noble/hashes/argon2.js');
type Argon2Args = Parameters<Argon2Module['argon2id']>;

/** A synchronous call that has not returned by then has a dead worker behind it. */
const WORKER_TIMEOUT_MS = 60_000;

/**
 * `argon2id` and `argon2idAsync` with noble's signatures, answered by
 * `opaque.interop.worker.mjs`. The synchronous one really blocks this thread
 * (in `Atomics.wait`) for as long as the hash takes, exactly as noble's does,
 * which the event-loop assertion in 'async variants' depends on.
 */
function outOfVmArgon2() {
    let worker: Worker | null = null;
    const started = (): Worker => {
        if (!worker) {
            worker = new Worker(join(__dirname, 'opaque.interop.worker.mjs'), {
                // Jest's resolver, so the worker loads the very file Jest would.
                workerData: { argon2Module: require.resolve('@noble/hashes/argon2.js') },
            });
            worker.unref();
        }
        return worker;
    };

    // Structured clone cannot carry `onProgress`. Nothing in this suite
    // observes progress, so it is dropped rather than relayed.
    const cloneable = (opts: Argon2Args[2]) =>
        Object.fromEntries(Object.entries(opts ?? {}).filter(([, value]) => typeof value !== 'function'));

    // The reply is deserialised in Node's own realm, not in Jest's sandbox, so
    // it is copied into a Uint8Array of this realm before anything sees it.
    const unwrap = (reply: { hash?: Uint8Array; error?: string } | undefined): Uint8Array => {
        if (!reply?.hash) throw new Error(`Argon2id worker failed: ${reply?.error ?? 'no reply'}`);
        return new Uint8Array(reply.hash);
    };

    const api = {
        /**
         * The options `ksf.ts` passed to each `argon2idAsync` call. The worker
         * frees this thread whatever `asyncTick` says, so on a phone only that
         * value decides how long noble holds the JS thread between yields;
         * 'async variants' checks it here instead.
         */
        asyncOpts: [] as Argon2Args[2][],
        argon2id(...[password, salt, opts]: Argon2Args): Uint8Array {
            const signal = new Int32Array(new SharedArrayBuffer(4));
            const { port1, port2 } = new MessageChannel();
            try {
                started().postMessage({ mode: 'sync', password, salt, opts: cloneable(opts), port: port2, signal }, [
                    port2,
                ]);
                if (Atomics.wait(signal, 0, 0, WORKER_TIMEOUT_MS) === 'timed-out') {
                    throw new Error(`Argon2id worker did not answer within ${WORKER_TIMEOUT_MS} ms`);
                }
                return unwrap(receiveMessageOnPort(port1)?.message);
            } finally {
                port1.close();
            }
        },
        argon2idAsync(...[password, salt, opts]: Argon2Args): Promise<Uint8Array> {
            api.asyncOpts.push(opts);
            const { port1, port2 } = new MessageChannel();
            return new Promise((resolve, reject) => {
                port1.once('message', (reply) => {
                    port1.close();
                    try {
                        resolve(unwrap(reply));
                    } catch (error) {
                        reject(error);
                    }
                });
                // The worker died or `afterAll` terminated it mid-hash: without
                // this the promise never settles, the awaiting test never
                // reaches its `finally`, and its interval keeps Jest alive. After
                // a reply this fires too, and a reject after resolve is a no-op.
                port1.once('close', () => reject(new Error('Argon2id worker exited before answering')));
                started().postMessage({ mode: 'async', password, salt, opts: cloneable(opts), port: port2 }, [port2]);
            });
        },
        terminate: async (): Promise<void> => {
            await worker?.terminate();
        },
    };
    return api;
}

const mockArgon2 = outOfVmArgon2();

afterAll(() => mockArgon2.terminate());

// Out of the VM a full-cost Argon2id call is ~1.5 s, and the slowest test
// ('async variants') makes three; this leaves a slow runner ample headroom.
jest.setTimeout(60_000);

const PASSWORD = 'correct horse battery staple';
const USER_ID = 'someone@beeflow.nl';

const hex = (bytes: Uint8Array): string =>
    Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** One reference-only registration, reused by the read-only assertions below. */
interface ReferenceFixture {
    readonly serverSetup: string;
    readonly registrationRecord: string;
    readonly exportKey: string;
    readonly serverStaticPublicKey: string;
}

let fixture: ReferenceFixture;

beforeAll(async () => {
    await refReady;
    const serverSetup = refServer.createSetup();
    const start = refClient.startRegistration({ password: PASSWORD });
    const { registrationResponse } = refServer.createRegistrationResponse({
        serverSetup,
        userIdentifier: USER_ID,
        registrationRequest: start.registrationRequest,
    });
    const finished = refClient.finishRegistration({
        clientRegistrationState: start.clientRegistrationState,
        registrationResponse,
        password: PASSWORD,
    });
    fixture = {
        serverSetup,
        registrationRecord: finished.registrationRecord,
        exportKey: finished.exportKey,
        serverStaticPublicKey: finished.serverStaticPublicKey,
    };
});

let restoreRandom: (() => void) | null = null;

/** Pin the entropy source for one test; undone in `afterEach`. */
function pinRandom(bytes: (length: number) => Uint8Array): void {
    restoreRandom?.();
    restoreRandom = __setRandomSourceForTests((target) => {
        target.set(bytes(target.length));
        return target;
    });
}

afterEach(() => {
    restoreRandom?.();
    restoreRandom = null;
});

describe('Argon2id outside the Jest VM', () => {
    it('is bit-identical to the implementation Jest itself loads', async () => {
        const inJest = jest.requireActual<Argon2Module>('@noble/hashes/argon2.js');
        // The seam is in place: what `ksf.ts` (and this file) imported is the
        // forwarder, not noble. Without this the comparison below would also
        // pass with the mock gone, and the suite would silently be slow again.
        expect(argon2id).not.toBe(inJest.argon2id);
        expect(argon2idAsync).not.toBe(inJest.argon2idAsync);

        // The KSF's salt, lanes and output length at a cost the sandbox can
        // afford. p = 4 keeps the lane mapping in the comparison.
        const input = utf8('beeflow-argon2-parity');
        const salt = new Uint8Array(16);
        const cheap = { t: 2, m: 1024, p: KSF_PARAMS.parallelism, dkLen: KSF_PARAMS.outputLength };
        const expected = hex(inJest.argon2id(input, salt, cheap));
        expect(hex(argon2id(input, salt, cheap))).toBe(expected);
        expect(hex(await argon2idAsync(input, salt, { ...cheap, asyncTick: 1 }))).toBe(expected);
    });

    // The forwarder frees this thread whatever noble does, so 'async variants'
    // can no longer see whether noble's own argon2idAsync yields. On a phone
    // that is what keeps sign-in from freezing the UI; an update that made it
    // yield only microtasks (as noble 1.x's nextTick did) would pass there.
    // So the real one, in this VM, at a cost the VM can afford.
    it("noble's own argon2idAsync gives the event loop back while it hashes", async () => {
        const inJest = jest.requireActual<Argon2Module>('@noble/hashes/argon2.js');
        let ticks = 0;
        const ticker = setInterval(() => {
            ticks += 1;
        }, 1);
        try {
            await inJest.argon2idAsync(new Uint8Array(32), new Uint8Array(16), {
                t: 1,
                m: 4096,
                p: KSF_PARAMS.parallelism,
                dkLen: KSF_PARAMS.outputLength,
                asyncTick: 5,
            });
        } finally {
            clearInterval(ticker);
        }
        expect(ticks).toBeGreaterThan(5);
    });
});

describe('wire format', () => {
    it('emits base64url without padding, which is the only dialect opaque-ke accepts', () => {
        const { startLoginRequest } = startLogin({ password: PASSWORD });
        expect(startLoginRequest).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(startLoginRequest).not.toContain('=');
        // Round-trip through the reference decoder: standard base64 is rejected
        // by it outright, so this passing proves the alphabet is right.
        expect(() =>
            refServer.startLogin({
                serverSetup: fixture.serverSetup,
                userIdentifier: USER_ID,
                registrationRecord: fixture.registrationRecord,
                startLoginRequest,
            }),
        ).not.toThrow();
    });

    it('produces messages of exactly the sizes the reference produces', () => {
        const mine = startRegistration({ password: PASSWORD });
        const theirs = refClient.startRegistration({ password: PASSWORD });
        expect(fromBase64(mine.registrationRequest).length).toBe(
            fromBase64(theirs.registrationRequest).length,
        );
        expect(fromBase64(mine.registrationRequest).length).toBe(32);

        const login = startLogin({ password: PASSWORD });
        expect(fromBase64(login.startLoginRequest).length).toBe(96);
        expect(fromBase64(fixture.registrationRecord).length).toBe(192);
        expect(fromBase64(fixture.exportKey).length).toBe(64);
    });
});

describe('serverSetup layout (unknown 5)', () => {
    it('is oprf_seed[64] || server_private_key[32] || dummy_client_public_key[32]', () => {
        const setup = fromBase64(fixture.serverSetup);
        expect(setup.length).toBe(128);
        const oprfSeed = setup.slice(0, 64);
        const serverPrivateKey = setup.slice(64, 96);
        const tail = setup.slice(96, 128);

        // Bytes 64..96 are the server's static scalar: G * sk is the key the
        // reference reports through both getPublicKey and finishRegistration.
        const scalar = ristretto255.Point.Fn.fromBytes(serverPrivateKey);
        const derivedPublicKey = ristretto255.Point.BASE.multiply(scalar).toBytes();
        expect(toBase64Url(derivedPublicKey)).toBe(refServer.getPublicKey(fixture.serverSetup));
        expect(toBase64Url(derivedPublicKey)).toBe(fixture.serverStaticPublicKey);

        // Bytes 0..64 are the OPRF seed. Deriving the per-user OPRF key from it
        // reproduces the reference's (deterministic) registration response.
        const start = refClient.startRegistration({ password: PASSWORD });
        const request = fromBase64(start.registrationRequest);
        const oprfKeySeed = expand(sha512, oprfSeed, concatBytes(utf8(USER_ID), utf8('OprfKey')), 32);
        const oprfKeys = ristretto255_oprf.oprf.deriveKeyPair(oprfKeySeed, utf8('OPAQUE-DeriveKeyPair'));
        const evaluated = ristretto255_oprf.oprf.blindEvaluate(oprfKeys.secretKey, request);
        const { registrationResponse } = refServer.createRegistrationResponse({
            serverSetup: fixture.serverSetup,
            userIdentifier: USER_ID,
            registrationRequest: start.registrationRequest,
        });
        expect(hex(evaluated)).toBe(hex(fromBase64(registrationResponse).slice(0, 32)));

        // The trailing 32 bytes are a ristretto255 *public* key (the dummy client
        // key used only for the enumeration-resistant fake-record path), not a
        // scalar: they always decode as a point.
        expect(() => ristretto255.Point.fromBytes(tail)).not.toThrow();
    });
});

describe('resolved constants', () => {
    it('pins the Argon2id parameters of the reference default preset', () => {
        // @serenity-kit/opaque v1.1.0 defaults to its "memory-constrained" preset.
        // Identified by replaying one fixed login under every named preset.
        expect(KSF_PARAMS).toEqual({
            iterations: 3,
            memoryKiB: 65536,
            parallelism: 4,
            outputLength: 64,
        });
    });

    it('pins the preamble version literal to OPAQUEv1-', () => {
        const preamble = buildPreamble(
            new Uint8Array(96),
            {
                credentialResponse: new Uint8Array(192),
                serverNonce: new Uint8Array(32),
                serverKeyshare: new Uint8Array(32),
                serverMac: new Uint8Array(64),
            },
            new Uint8Array(32),
            new Uint8Array(32),
        );
        expect(new TextDecoder().decode(preamble.slice(0, 9))).toBe('OPAQUEv1-');
        // "OPAQUEv1-" | ctx(2) | client_id(2+32) | ke1(96) | server_id(2+32)
        //   | credential_response(192) | server_nonce(32) | server_keyshare(32)
        expect(preamble.length).toBe(9 + 2 + 34 + 96 + 34 + 192 + 32 + 32);
    });

    it('uses the RFC 9497 base-mode ristretto255-SHA512 OPRF', () => {
        expect(ristretto255_oprf.name).toBe('ristretto255-SHA512');
    });
});

describe('login-path oracle (their registration, our login)', () => {
    let loginResponse: string;
    let serverLoginState: string;
    let clientLoginState: string;

    beforeAll(() => {
        const started = startLogin({ password: PASSWORD });
        clientLoginState = started.clientLoginState;
        const server = refServer.startLogin({
            serverSetup: fixture.serverSetup,
            userIdentifier: USER_ID,
            registrationRecord: fixture.registrationRecord,
            startLoginRequest: started.startLoginRequest,
        });
        loginResponse = server.loginResponse;
        serverLoginState = server.serverLoginState;
    });

    it('recovers the client public key stored in their registration record', () => {
        // Isolates the envelope: OPRF output -> KSF -> randomized password ->
        // envelope keys -> DeriveDiffieHellmanKeyPair. No 3DH involved.
        const ke2 = fromBase64(loginResponse);
        const state = fromBase64(clientLoginState);
        const blindScalar = state.slice(0, 32);
        const oprfOutput = finalize(utf8(PASSWORD), blindScalar, ke2.slice(0, 32));
        const randomizedPassword = deriveRandomizedPassword(oprfOutput, stretch(oprfOutput));
        const { serverPublicKey, envelope } = unmaskResponse(
            randomizedPassword,
            ke2.slice(32, 64),
            ke2.slice(64, 192),
        );
        expect(toBase64Url(serverPublicKey)).toBe(fixture.serverStaticPublicKey);

        const recovered = recover(randomizedPassword, envelope, serverPublicKey, undefined);
        expect(recovered).not.toBeNull();
        const record = fromBase64(fixture.registrationRecord);
        expect(hex(recovered!.clientKeyPair.publicKey)).toBe(hex(record.slice(0, 32)));
        // The record's masking key and envelope also fall out of the same PRK.
        expect(hex(concatBytes(envelope.nonce, envelope.authTag))).toBe(hex(record.slice(96, 192)));
        expect(toBase64Url(recovered!.exportKey)).toBe(fixture.exportKey);
    });

    it('derives their exportKey and gets our KE3 accepted by their server', () => {
        const result = finishLogin({ clientLoginState, loginResponse, password: PASSWORD });
        expect(result).not.toBeNull();
        const { exportKey, sessionKey, finishLoginRequest, serverStaticPublicKey } =
            result as FinishLoginResult;

        // Checked before the MAC so an envelope/OPRF/KSF break is distinguishable
        // from a preamble/3DH break.
        expect(exportKey).toBe(fixture.exportKey);
        expect(serverStaticPublicKey).toBe(fixture.serverStaticPublicKey);

        const serverFinish = refServer.finishLogin({ serverLoginState, finishLoginRequest });
        expect(serverFinish.sessionKey).toBe(sessionKey);
    });
});

describe('registration-path oracle (our registration, their login)', () => {
    it('produces a record their client can log in against', () => {
        const serverSetup = refServer.createSetup();
        const started = startRegistration({ password: PASSWORD });
        const { registrationResponse } = refServer.createRegistrationResponse({
            serverSetup,
            userIdentifier: USER_ID,
            registrationRequest: started.registrationRequest,
        });
        const mine = finishRegistration({
            clientRegistrationState: started.clientRegistrationState,
            registrationResponse,
            password: PASSWORD,
        });
        expect(fromBase64(mine.registrationRecord).length).toBe(192);
        expect(mine.serverStaticPublicKey).toBe(refServer.getPublicKey(serverSetup));

        const theirLogin = refClient.startLogin({ password: PASSWORD });
        const server = refServer.startLogin({
            serverSetup,
            userIdentifier: USER_ID,
            registrationRecord: mine.registrationRecord,
            startLoginRequest: theirLogin.startLoginRequest,
        });
        const theirFinish = refClient.finishLogin({
            clientLoginState: theirLogin.clientLoginState,
            loginResponse: server.loginResponse,
            password: PASSWORD,
        });
        expect(theirFinish).toBeDefined();
        expect(theirFinish!.exportKey).toBe(mine.exportKey);

        const serverFinish = refServer.finishLogin({
            serverLoginState: server.serverLoginState,
            finishLoginRequest: theirFinish!.finishLoginRequest,
        });
        expect(serverFinish.sessionKey).toBe(theirFinish!.sessionKey);
    });
});

describe('round trip against their server', () => {
    it('registers and logs in with our client on both ends', () => {
        const serverSetup = refServer.createSetup();
        const started = startRegistration({ password: PASSWORD });
        const { registrationResponse } = refServer.createRegistrationResponse({
            serverSetup,
            userIdentifier: USER_ID,
            registrationRequest: started.registrationRequest,
        });
        const registered = finishRegistration({
            clientRegistrationState: started.clientRegistrationState,
            registrationResponse,
            password: PASSWORD,
        });

        const login = startLogin({ password: PASSWORD });
        const server = refServer.startLogin({
            serverSetup,
            userIdentifier: USER_ID,
            registrationRecord: registered.registrationRecord,
            startLoginRequest: login.startLoginRequest,
        });
        const result = finishLogin({
            clientLoginState: login.clientLoginState,
            loginResponse: server.loginResponse,
            password: PASSWORD,
        });
        expect(result).not.toBeNull();
        expect(result!.exportKey).toBe(registered.exportKey);
        expect(
            refServer.finishLogin({
                serverLoginState: server.serverLoginState,
                finishLoginRequest: result!.finishLoginRequest,
            }).sessionKey,
        ).toBe(result!.sessionKey);
    });

    it('binds custom client/server identifiers the same way the reference does', () => {
        const identifiers = { client: 'alice@beeflow.nl', server: 'beeflow.nl' };
        const serverSetup = refServer.createSetup();
        const started = startRegistration({ password: PASSWORD });
        const { registrationResponse } = refServer.createRegistrationResponse({
            serverSetup,
            userIdentifier: USER_ID,
            registrationRequest: started.registrationRequest,
        });
        const registered = finishRegistration({
            clientRegistrationState: started.clientRegistrationState,
            registrationResponse,
            password: PASSWORD,
            identifiers,
        });

        // Their client must be able to open the envelope we sealed under those
        // identities — which only works if the CleartextCredentials layout and
        // the identity defaults agree.
        const theirLogin = refClient.startLogin({ password: PASSWORD });
        const server = refServer.startLogin({
            serverSetup,
            userIdentifier: USER_ID,
            registrationRecord: registered.registrationRecord,
            startLoginRequest: theirLogin.startLoginRequest,
            identifiers,
        });
        const theirFinish = refClient.finishLogin({
            clientLoginState: theirLogin.clientLoginState,
            loginResponse: server.loginResponse,
            password: PASSWORD,
            identifiers,
        });
        expect(theirFinish).toBeDefined();
        expect(theirFinish!.exportKey).toBe(registered.exportKey);
        expect(
            refServer.finishLogin({
                serverLoginState: server.serverLoginState,
                finishLoginRequest: theirFinish!.finishLoginRequest,
                identifiers,
            }).sessionKey,
        ).toBe(theirFinish!.sessionKey);
    });
});

describe('failure modes', () => {
    it('returns null — never throws — for a wrong password', () => {
        const login = startLogin({ password: 'not-the-password' });
        const server = refServer.startLogin({
            serverSetup: fixture.serverSetup,
            userIdentifier: USER_ID,
            registrationRecord: fixture.registrationRecord,
            startLoginRequest: login.startLoginRequest,
        });
        let result: FinishLoginResult | null = null;
        expect(() => {
            result = finishLogin({
                clientLoginState: login.clientLoginState,
                loginResponse: server.loginResponse,
                password: 'not-the-password',
            });
        }).not.toThrow();
        expect(result).toBeNull();
        // The reference signals the same case with `undefined`.
        expect(
            refClient.finishLogin({
                clientLoginState: refClient.startLogin({ password: 'nope' }).clientLoginState,
                loginResponse: server.loginResponse,
                password: 'nope',
            }),
        ).toBeUndefined();
    });

    it('throws on a structurally invalid message rather than reporting a bad password', () => {
        const login = startLogin({ password: PASSWORD });
        expect(() =>
            finishLogin({
                clientLoginState: login.clientLoginState,
                loginResponse: toBase64Url(new Uint8Array(319)),
                password: PASSWORD,
            }),
        ).toThrow(/loginResponse/);
    });

    /**
     * `loginResponse` arrives from the network, and both call sites
     * (`src/core/auth/api.ts`, `src/features/onboarding/api/encryption.ts`) hand it
     * straight to `finishLoginAsync` without a try/catch. A hostile response of
     * the *correct* length therefore has to fail as the one documented error
     * type, not as a bare `Error` from inside noble's point decoder.
     */
    it.each([
        ['non-canonical evaluated element', new Uint8Array(320).fill(0xff)],
        ['identity evaluated element', new Uint8Array(320)],
    ])('rejects a length-correct hostile loginResponse (%s) as an OpaqueError', (_label, bytes) => {
        const login = startLogin({ password: PASSWORD });
        let thrown: unknown;
        try {
            finishLogin({
                clientLoginState: login.clientLoginState,
                loginResponse: toBase64Url(bytes),
                password: PASSWORD,
            });
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(OpaqueError);
        expect((thrown as Error).message).toMatch(/evaluated element/);
    });

    it('rejects a degenerate (identity) server keyshare instead of doing a constant DH', () => {
        // `Point.fromBytes` accepts the all-zero ristretto255 encoding and
        // multiplying it by any scalar yields the all-zero encoding, so an
        // unchecked peer key would silently flatten two of the three 3DH legs.
        expect(() => diffieHellman(ristretto255.Point.Fn.toBytes(9n), new Uint8Array(32))).toThrow(
            OpaqueError,
        );
        expect(() => diffieHellman(ristretto255.Point.Fn.toBytes(9n), new Uint8Array(32).fill(0xff))).toThrow(
            OpaqueError,
        );
    });

    it('rejects a registrationResponse carrying an unusable server public key', () => {
        // Taken on trust at registration and sealed into the envelope, so nothing
        // downstream would ever flag it — it has to be caught here.
        const started = startRegistration({ password: PASSWORD });
        const response = new Uint8Array(64);
        response.set(fromBase64(started.registrationRequest), 0); // valid element
        // ...followed by 32 zero bytes as the "server public key".
        expect(() =>
            finishRegistration({
                clientRegistrationState: started.clientRegistrationState,
                registrationResponse: toBase64Url(response),
                password: PASSWORD,
            }),
        ).toThrow(OpaqueError);
    });
});

describe('async variants', () => {
    it('agree byte for byte with the synchronous ones', async () => {
        // Pin the RNG so both paths produce the same envelope nonce and keyshare.
        const scripted = (seed: number) => {
            let counter = seed;
            return (length: number) => {
                const out = new Uint8Array(length);
                for (let i = 0; i < length; i++) out[i] = (counter = (counter * 1103515245 + 12345) >>> 0) & 0xff;
                return out;
            };
        };

        const serverSetup = refServer.createSetup();
        pinRandom(scripted(1));
        const startedSync = startRegistration({ password: PASSWORD });
        pinRandom(scripted(1));
        const startedAsync = startRegistration({ password: PASSWORD });
        expect(startedAsync.registrationRequest).toBe(startedSync.registrationRequest);

        const { registrationResponse } = refServer.createRegistrationResponse({
            serverSetup,
            userIdentifier: USER_ID,
            registrationRequest: startedSync.registrationRequest,
        });
        // A macrotask counter. It can only advance while control is back with the
        // event loop, so it distinguishes a genuinely yielding implementation
        // from a Promise wrapped around a blocking Argon2 call — the latter
        // would leave `duringAsync` at 0 exactly like the synchronous variant.
        // The out-of-VM seam keeps that distinction: its `argon2id` parks this
        // thread in Atomics.wait, its `argon2idAsync` leaves the loop free. So
        // the counter checks that `ksf.ts` reaches for the yielding primitive,
        // and the `asyncTick` it passes is checked separately below: on a
        // phone that value is how long each slice holds the JS thread.
        let ticks = 0;
        // unref: should the awaited call never settle, this alone must not
        // keep Jest from exiting.
        const ticker = setInterval(() => {
            ticks += 1;
        }, 5).unref();
        let sync: ReturnType<typeof finishRegistration>;
        let asyncResult: Awaited<ReturnType<typeof finishRegistrationAsync>>;
        let duringSync: number;
        let duringAsync: number;
        try {
            pinRandom(scripted(2));
            ticks = 0;
            sync = finishRegistration({
                clientRegistrationState: startedSync.clientRegistrationState,
                registrationResponse,
                password: PASSWORD,
            });
            duringSync = ticks;

            pinRandom(scripted(2));
            ticks = 0;
            mockArgon2.asyncOpts.length = 0;
            asyncResult = await finishRegistrationAsync({
                clientRegistrationState: startedSync.clientRegistrationState,
                registrationResponse,
                password: PASSWORD,
            });
            duringAsync = ticks;
        } finally {
            clearInterval(ticker);
        }
        expect(asyncResult).toEqual(sync);
        expect(duringSync).toBe(0);
        expect(duringAsync).toBeGreaterThan(10);
        // noble's own default is 10 ms. Above ~50 ms a 60 fps UI visibly
        // stutters during sign-in; 0 or a negative value is not a yield.
        expect(mockArgon2.asyncOpts.length).toBeGreaterThan(0);
        for (const opts of mockArgon2.asyncOpts) {
            const tick = opts?.asyncTick ?? 10;
            expect(tick).toBeGreaterThan(0);
            expect(tick).toBeLessThanOrEqual(50);
        }

        restoreRandom?.();
        restoreRandom = null;
        const login = startLogin({ password: PASSWORD });
        const server = refServer.startLogin({
            serverSetup,
            userIdentifier: USER_ID,
            registrationRecord: sync.registrationRecord,
            startLoginRequest: login.startLoginRequest,
        });
        const asyncLogin = await finishLoginAsync({
            clientLoginState: login.clientLoginState,
            loginResponse: server.loginResponse,
            password: PASSWORD,
        });
        expect(asyncLogin).not.toBeNull();
        expect(asyncLogin!.exportKey).toBe(sync.exportKey);
        expect(
            refServer.finishLogin({
                serverLoginState: server.serverLoginState,
                finishLoginRequest: asyncLogin!.finishLoginRequest,
            }).sessionKey,
        ).toBe(asyncLogin!.sessionKey);
    });
});

describe('injectable entropy', () => {
    it('makes startRegistration reproducible for deterministic tests', () => {
        const fixed = (length: number) => new Uint8Array(length).fill(7);
        pinRandom(fixed);
        const first = startRegistration({ password: PASSWORD });
        pinRandom(fixed);
        const second = startRegistration({ password: PASSWORD });
        expect(second).toEqual(first);

        // ...and a *different* pinned source produces a different request. Without
        // this the test above would also pass if the injection silently did
        // nothing and the blind were not random at all.
        pinRandom((length: number) => new Uint8Array(length).fill(9));
        const third = startRegistration({ password: PASSWORD });
        expect(third.registrationRequest).not.toBe(first.registrationRequest);

        // The reference server accepts a request built from injected entropy,
        // which is what makes the deterministic fixtures above legitimate input.
        expect(() =>
            refServer.createRegistrationResponse({
                serverSetup: fixture.serverSetup,
                userIdentifier: USER_ID,
                registrationRequest: first.registrationRequest,
            }),
        ).not.toThrow();
    });
});
