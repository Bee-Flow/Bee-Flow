// @typecheck strict
/**
 * The account half of the login throttle (auth/loginThrottle.js): which keys
 * one attempt counts against, and the failure bookkeeping on one such key.
 * Split out so the throttle's storage layer and its request-facing API stay
 * in one file and this policy in another; it reads and writes only through
 * the store it is handed.
 */

const { recordAuthEvent } = require('../telemetry/metrics');
const log = require('../telemetry/log');

/**
 * @typedef {{
 *   incr: (key: string, ttlMs: number) => Promise<number>,
 *   set: (key: string, value: unknown, ttlMs: number) => Promise<unknown>,
 *   del: (...keys: string[]) => Promise<unknown>,
 *   ttl: (key: string) => Promise<number>,
 *   config: { accountWindowMs: number, delayAfter: number, delayMaxMs: number, delayStepMs: number, accountMaxFailures: number },
 *   lockStepsMs: number[],
 *   lockHistoryTtlMs: number,
 * }} AccountStore
 */

/**
 * Normalise the submitted identifier so `Admin`, `admin` and ` admin ` share one
 * counter — otherwise case alone multiplies an attacker's budget.
 * @param {string} identifier
 */
function normalizeIdentifier(identifier) {
    return String(identifier || '').trim().toLowerCase().slice(0, 254);
}

/**
 * The account keys one attempt counts against: the submitted identifier, and
 * — once the route has resolved it — the account itself. One account is
 * reachable by id, username and e-mail address; a counter per spelling gave
 * three times the guesses, so the resolved id carries its own counter that
 * every spelling feeds and every spelling is refused by. The identifier key
 * stays: it is what the gate at the top of a route can check before any
 * lookup, and it is all an unknown name has.
 * @param {string} identifier
 * @param {string | null | undefined} accountId
 */
function accountKeys(identifier, accountId) {
    const keys = [];
    const id = normalizeIdentifier(identifier);
    if (id) keys.push(id);
    if (accountId) keys.push(`account\u0000${String(accountId)}`);
    return keys;
}

/**
 * @param {string} id
 */
const kAcctFail = (id) => `lt:af:${id}`;
/**
 * @param {string} id
 */
const kAcctLock = (id) => `lt:al:${id}`;
/**
 * @param {string} id
 */
const kAcctLockRounds = (id) => `lt:ar:${id}`;

/**
 * The account half of one failure: the counter, the escalating lock, and the
 * in-flight check against a lock set a moment ago.
 * @param {AccountStore} store
 * @param {string} key an entry of accountKeys()
 * @returns {Promise<{delayMs: number, locked: boolean, retryAfterSec: number}>}
 */
async function recordAccountFailure(store, key) {
    const { config, incr, set, del, ttl } = store;
    let delayMs = 0;
    let locked = false;
    let retryAfterSec = 0;
    const fails = await incr(kAcctFail(key), config.accountWindowMs);
    if (fails > config.delayAfter) {
        delayMs = Math.min(config.delayMaxMs, (fails - config.delayAfter) * config.delayStepMs);
    }
    if (fails >= config.accountMaxFailures) {
        // How many times has this identifier been locked recently?
        // Escalate rather than handing out the same 60 seconds forever.
        const rounds = await incr(kAcctLockRounds(key), store.lockHistoryTtlMs);
        const lockMs = store.lockStepsMs[Math.min(rounds - 1, store.lockStepsMs.length - 1)];
        await set(kAcctLock(key), 1, lockMs);
        await del(kAcctFail(key));   // the lock replaces the counter
        locked = true;
        retryAfterSec = Math.ceil(lockMs / 1000);
        recordAuthEvent({ kind: 'login_lockout', status: 'blocked' });
        log.warn(`[LoginThrottle] identifier locked for ${Math.round(lockMs / 1000)}s after ${fails} failed attempts (round ${rounds})`);
    } else {
        // The counter alone is not authoritative, because the branch
        // above DELETES it: a request already in flight when the lock
        // was set increments a fresh counter, sees 1, and would be
        // answered 401 as though nothing had happened. A pentest fired
        // 20 at once and got 11 through against a threshold of 10 —
        // that surplus is bounded only by the attacker's concurrency.
        //
        // The lock is what is authoritative once it exists, so ask.
        // One extra read, on the failure path only.
        const lockTtl = await ttl(kAcctLock(key));
        if (lockTtl > 0) {
            locked = true;
            retryAfterSec = Math.ceil(lockTtl / 1000);
        }
    }
    return { delayMs, locked, retryAfterSec };
}

module.exports = { normalizeIdentifier, accountKeys, kAcctFail, kAcctLock, kAcctLockRounds, recordAccountFailure };
