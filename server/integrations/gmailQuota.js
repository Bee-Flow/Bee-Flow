// @typecheck
/**
 * Gmail per-user quota, kept on our side.
 *
 * Gmail allows 6,000 quota units per minute per user per project, and charges
 * per method: messages.get and messages.attachments.get 20 units, messages.list
 * 5, threads.get 40, messages.send 100
 * (https://developers.google.com/workspace/gmail/api/reference/quota).
 * A search of 200 messages followed by their reads and attachments goes over
 * that. Google then answers 429, gaxios retries three times with growing waits
 * (~0.6 s, 1.5 s, 3.5 s) and gives up, and gmail_search dropped the message.
 * Slow AND incomplete.
 *
 * This bucket spends units before a call goes out: up to a burst it passes at
 * once, beyond it the call waits for the refill (100 units a second). Shared by
 * every Gmail call of the same account in this process (a run's parallel items,
 * a search's metadata fetches, a chat at the same time), keyed by a hash of
 * the account's refresh token, never the token itself.
 */
const crypto = require('crypto');

const PER_MINUTE = 6000;
const REFILL_PER_MS = PER_MINUTE / 60_000;
// Below the minute's budget, so another process of ours (or a burst we did
// not see) still leaves Google some room.
const BURST = 1500;

/** Units per call (Gmail's table); an unknown method is charged as a get. */
const COST = {
    'messages.list': 5,
    'messages.get': 20,
    'messages.attachments.get': 20,
    'messages.modify': 5,
    'messages.trash': 5,
    'messages.send': 100,
    'threads.get': 40,
    'labels.list': 1,
    'drafts.create': 10,
};
const DEFAULT_COST = 20;

/** @type {Map<string, { units: number, at: number }>} */
const buckets = new Map();

function accountKey(session) {
    const id = session?.refreshToken || session?.accessToken || '';
    return id ? crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 24) : 'anonymous';
}

/**
 * Milliseconds to wait before `units` may be spent, spending them. Pure apart
 * from the bucket map; `now` is injectable for tests.
 */
function reserve(key, units, now = Date.now()) {
    const b = buckets.get(key) || { units: BURST, at: now };
    b.units = Math.min(BURST, b.units + (now - b.at) * REFILL_PER_MS);
    b.at = now;
    b.units -= units;
    buckets.set(key, b);
    return b.units >= 0 ? 0 : Math.ceil(-b.units / REFILL_PER_MS);
}

/** Wait until `method` may be called for this account. */
async function take(session, method) {
    const wait = reserve(accountKey(session), COST[method] ?? DEFAULT_COST);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
}

/**
 * The Gmail client with every `users.*` method going through the bucket first.
 * `gmail.users.messages.get(...)` stays exactly what callers write.
 */
function withQuota(gmail, session) {
    const wrap = (obj, path) => new Proxy(obj, {
        get(target, prop, receiver) {
            const v = Reflect.get(target, prop, receiver);
            if (typeof prop !== 'string') return v;
            const here = path ? `${path}.${prop}` : prop;
            if (typeof v === 'function') {
                return async (...args) => {
                    await take(session, here);
                    return v.apply(target, args);
                };
            }
            return v && typeof v === 'object' ? wrap(v, here) : v;
        },
    });
    return new Proxy(gmail, {
        get(target, prop, receiver) {
            const v = Reflect.get(target, prop, receiver);
            return prop === 'users' && v && typeof v === 'object' ? wrap(v, '') : v;
        },
    });
}

module.exports = { withQuota, reserve, take, accountKey, COST, BURST, PER_MINUTE, _buckets: buckets };
