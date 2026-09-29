/**
 * The Argon2id half of `opaque.interop.test.ts`, run in a worker thread.
 *
 * TEST-ONLY. Nothing in the app imports this file.
 *
 * Inside Jest's VM sandbox @noble/hashes' Argon2id runs about 14 times slower
 * than in plain Node (~21 s against ~1.5 s per call at the KSF's 64 MiB × 3
 * passes), which made the interop suite most of the mobile job's wall time. A
 * worker thread is a fresh Node isolate, outside that sandbox. The test mocks
 * `@noble/hashes/argon2.js` so that `ksf.ts` still runs in Jest with its own
 * salt and parameters; only the primitive it calls is answered from here.
 *
 * The module path comes from the test (`workerData.argon2Module`), resolved by
 * Jest's own resolver, so both sides run the same file and the test's parity
 * case compares like with like.
 *
 * Protocol, one message per call: `{ mode, password, salt, opts, port, signal }`.
 * `mode` picks `argon2id` ('sync') or `argon2idAsync` ('async'), the same
 * function `ksf.ts` called. The reply `{ hash }` or `{ error }` goes to `port`.
 * `signal` is set for a synchronous call: the caller is parked in
 * `Atomics.wait` on it and reads the reply with `receiveMessageOnPort` once it
 * flips to 1.
 */

import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

// Not awaited at the top level: a failed import has to come back as a reply,
// or a synchronous caller would sit in Atomics.wait until its timeout. The
// empty catch only keeps that rejection from counting as unhandled (which would
// kill the worker before the first message arrives); every `await` below still
// sees it.
const argon2 = import(pathToFileURL(workerData.argon2Module).href);
argon2.catch(() => {});

parentPort.on('message', async ({ mode, password, salt, opts, port, signal }) => {
    let reply;
    try {
        const { argon2id, argon2idAsync } = await argon2;
        const hash = mode === 'sync' ? argon2id(password, salt, opts) : await argon2idAsync(password, salt, opts);
        reply = { hash };
    } catch (error) {
        reply = { error: error instanceof Error ? (error.stack ?? error.message) : String(error) };
    }
    // The caller closes the channel once it has read the reply; closing it from
    // this side first could race the synchronous read.
    port.postMessage(reply);
    if (signal) {
        Atomics.store(signal, 0, 1);
        Atomics.notify(signal, 0);
    }
});
