/**
 * Test-only: the RECORDED answers of agent-hub modules that no longer exist.
 *
 * The web's list chooser (mapping/listShape.js, mapping/mismatch.js) and its
 * value-part parser (mapping/valueParts.js) were replaced by the shared
 * mapping core (server/shared/mapping) and deleted from agent-hub. The phone
 * still runs its ports of them until it adopts the core too (M7, which
 * deletes the ports and these recordings together). Until then the
 * differential lockstep tests keep comparing each port with the web: with
 * what the web module answered, recorded call by call on the day it was
 * deleted, in ./frozenWeb/<name>.json.
 *
 * frozenWeb(name) is a stand-in for requireWeb(...): every function is a
 * lookup of the recorded call with the same arguments, and an unrecorded call
 * throws, so a new test case cannot pass by accident. The recordings are
 * written by running the lockstep tests with FROZEN_WEB_RECORD=1 while the
 * web module still exists; there is no reason to do that again.
 */

import fs from 'node:fs';
import path from 'node:path';

import { requireWeb, type WebModule } from './web';

const DIR = path.join(__dirname, 'frozenWeb');

type Encoded = unknown;

/** A value as JSON that keeps what plain JSON loses (undefined, functions, Maps, Sets). */
function encode(value: unknown): Encoded {
    if (value === undefined) return { $u: 1 };
    if (typeof value === 'function') return { $f: String(value) };
    if (typeof value === 'bigint') return { $n: String(value) };
    if (typeof value === 'number' && !Number.isFinite(value)) return { $num: String(value) };
    if (value instanceof Map) return { $map: [...value.entries()].map(([k, v]) => [encode(k), encode(v)]) };
    if (value instanceof Set) return { $set: [...value.values()].map(encode) };
    if (value instanceof RegExp) return { $re: String(value) };
    if (Array.isArray(value)) return value.map(encode);
    if (value && typeof value === 'object') {
        const out: Record<string, Encoded> = {};
        for (const [k, v] of Object.entries(value)) out[k] = encode(v);
        return { $o: out };
    }
    return value;
}

function decode(value: Encoded): unknown {
    if (Array.isArray(value)) return value.map(decode);
    if (!value || typeof value !== 'object') return value;
    const v = value as Record<string, unknown>;
    if ('$u' in v) return undefined;
    if ('$n' in v) return BigInt(v.$n as string);
    if ('$num' in v) return Number(v.$num);
    if ('$map' in v) return new Map((v.$map as [Encoded, Encoded][]).map(([k, x]) => [decode(k), decode(x)]));
    if ('$set' in v) return new Set((v.$set as Encoded[]).map(decode));
    if ('$re' in v) {
        const m = /^\/(.*)\/([a-z]*)$/s.exec(v.$re as string) as RegExpExecArray;
        return new RegExp(m[1] as string, m[2]);
    }
    if ('$f' in v) return v.$f;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries((v.$o as Record<string, Encoded>) || {})) out[k] = decode(x);
    return out;
}

const callKey = (name: string, args: unknown[]) => `${name}(${JSON.stringify(encode(args))})`;

type Recording = Record<string, Encoded>;

/** Record every answer of the real web module (FROZEN_WEB_RECORD=1). */
function recorder(rel: string, file: string): WebModule {
    const real = requireWeb(rel);
    const rec: Recording = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    afterAll(() => {
        // One recorded call per line, sorted: small, and a diff names the call.
        const lines = Object.keys(rec).sort().map(k => `${JSON.stringify(k)}:${JSON.stringify(rec[k])}`);
        fs.mkdirSync(DIR, { recursive: true });
        fs.writeFileSync(file, `{\n${lines.join(',\n')}\n}\n`);
    });
    return new Proxy({} as WebModule, {
        get(_target, prop: string) {
            const value = real[prop];
            if (typeof value !== 'function') {
                rec[`.${prop}`] = encode(value);
                return value;
            }
            return (...args: unknown[]) => {
                const out = value(...args);
                rec[callKey(prop, args)] = encode(out);
                return out;
            };
        },
    });
}

/** Replay the recorded answers. */
function replayer(name: string, file: string): WebModule {
    const rec: Recording = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Proxy({} as WebModule, {
        get(_target, prop: string) {
            if (Object.prototype.hasOwnProperty.call(rec, `.${prop}`)) return decode(rec[`.${prop}`]);
            return (...args: unknown[]) => {
                const key = callKey(prop, args);
                if (!Object.prototype.hasOwnProperty.call(rec, key)) {
                    throw new Error(`frozenWeb(${name}): no recorded answer for ${key.slice(0, 200)}`);
                }
                return decode(rec[key]);
            };
        },
    });
}

const loaded = new Map<string, WebModule>();

/**
 * The recorded web module at `rel`, in place of requireWeb. See the header.
 * Call it at the top level of a test file (recording registers an afterAll).
 */
export function frozenWeb(name: string, rel: string): WebModule {
    const known = loaded.get(name);
    if (known) return known;
    const file = path.join(DIR, `${name}.json`);
    const mod = process.env.FROZEN_WEB_RECORD === '1' ? recorder(rel, file) : replayer(name, file);
    loaded.set(name, mod);
    return mod;
}
