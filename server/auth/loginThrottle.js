// @typecheck
/**
 * loginThrottle.js — abuse resistance for the authentication perimeter.
 *
 * A black-box pentest sent 120 consecutive failed logins to /auth/admin-login in
 * roughly two seconds. Every one returned 401. No 429, no lockout, no delay, no
 * CAPTCHA. The same held for /auth/signup and /auth/forgot-password: 190 requests
 * across four endpoints produced exactly zero throttling of any kind. The only
 * brake on the whole surface was the ~460 ms bcrypt cost, which caps ONE
 * connection at about two guesses a second and does nothing at all about the
 * hundred connections an attacker actually opens.
 *
 * WHY THIS IS NOT JUST express-rate-limit ON A ROUTE
 * A per-IP request cap is the wrong primary control for this endpoint:
 *   • Too tight and a NAT'd office — 200 people signing in between 09:00 and
 *     09:15 from one address — locks itself out. Worse, this product runs behind
 *     a Scaleway L4 load balancer that (outside the PROXY-protocol fix already
 *     applied on dev) presents the SAME source IP for every visitor, so a strict
 *     per-IP failure cap would take the entire production tenant base offline.
 *   • Too loose and it stops nothing, because a distributed attacker rotates IPs
 *     for free.
 * So the PRIMARY control here is per-ACCOUNT: consecutive failures against one
 * identifier, with an escalating lockout. That is the thing an attacker cannot
 * dodge by changing IP, and it can never collateral-damage a whole tenant. The
 * per-IP failure cap is a deliberately generous SECONDARY backstop (it still
 * catches the 120-in-two-seconds spray) and can be switched off entirely for
 * deployments where the client IP is not trustworthy.
 *
 * FAILURES, NOT REQUESTS
 * Every counter here is incremented on a FAILED authentication, never on a
 * successful one, and a success clears the account's counter. A legitimate user
 * who signs in forty times a day is invisible to this module; a user who fails
 * ten times in fifteen minutes is not.
 *
 * NO NEW ENUMERATION ORACLE
 * The account counter is keyed on the SUBMITTED identifier, normalised, whether
 * or not that account exists. Keying it on the resolved user id would have made
 * the throttle itself an existence oracle — lock out after ten tries only for
 * real accounts — which is precisely the class of bug the constant-time login
 * fix in loginRoutes.js exists to close. Everything an attacker can observe here
 * (429s, Retry-After, the progressive delay) behaves identically for
 * `admin` and for `nonexistent_zzz1`.
 *
 * STORAGE
 * Redis when it is configured and healthy, so a limit is fleet-wide rather than
 * per-replica; an in-memory fallback otherwise, which is what self-hosted
 * installs without Redis use. Every storage operation FAILS OPEN: a throttle
 * that turns a Redis blip into an authentication outage has done more damage
 * than the attack it was guarding against. See utils/perUserRateLimit.js, which
 * makes the same trade for the coarse request caps mounted alongside this.
 */

const crypto = require('crypto');
const { clientIp, isPrivateIp } = require('./signupGuards');
const { recordAuthEvent } = require('../telemetry/metrics');
const log = require('../telemetry/log');

/**
 * The source address, plus whether it can be trusted to identify one client.
 *
 * A loopback / RFC1918 / link-local peer means one of two things: local
 * development, or a reverse proxy that is not forwarding the real client
 * address. On this platform the second case is live — Scaleway's L4 load
 * balancer hides the visitor IP unless PROXY protocol is enabled, which is done
 * on dev and still pending on prod. In that state every visitor arrives as the
 * SAME private address.
 *
 * The first version of this module reacted by switching the per-IP half OFF
 * whenever the address looked untrustworthy. That was safe and it was also a
 * hole: a retest sprayed one password across forty different usernames and hit
 * nothing at all, because per-ACCOUNT limits are structurally blind to breadth
 * and the per-IP half had disabled itself. On localhost and on production —
 * the two environments that actually matter right now — there was no breadth
 * control.
 *
 * So the distinction is no longer on/off, it is on RESPONSE:
 *   • trusted address  → hard 429 block at the threshold, as before;
 *   • untrusted address → count anyway, and answer with a growing DELAY.
 * A delay is safe under misattribution in a way a block never is. Failed logins
 * are the only thing slowed and successful ones are untouched, so a whole
 * tenant base sharing one load-balancer IP is never locked out — the worst case
 * is that someone who mistypes their password during an active attack waits a
 * couple of seconds. An attacker paying that on every guess of a spray loses
 * the only thing that made spraying attractive: speed.
 */
function sourceAddress(req) {
    try {
        const ip = clientIp(req);
        if (!ip) return { ip: null, trusted: false };

        // clientIp() reads req.ip, which Express derives from X-Forwarded-For
        // under `trust proxy`. Through our nginx that is sound: every proxy block
        // sets $proxy_add_x_forwarded_for, which APPENDS the real peer, so the
        // entry Express reads was written by nginx, not by the caller.
        //
        // A client talking straight to the API port supplies the whole header
        // itself. The danger there is not evasion — rotating the key still leaves
        // the per-account limit — but the reverse: claim a public address, spend
        // the failure budget, and leave a block sitting on somebody else's IP.
        //
        // Those two cases are separable by the peer, and only by LOOPBACK
        // specifically. Through nginx the peer is the container's bridge address
        // (172.x — private, but not loopback), so production keeps its hard
        // block. The API port is bound to 127.0.0.1, so anything reaching it
        // directly has a loopback peer. A different address arriving over a
        // loopback connection is therefore a claim, not an observation: good
        // enough to key a bucket, never grounds to block.
        const peer = String(req.socket?.remoteAddress || req.connection?.remoteAddress || '')
            .replace(/^::ffff:/, '').toLowerCase();
        const viaLoopback = peer === '::1' || peer === 'localhost' || peer.startsWith('127.');
        const claimed = viaLoopback && ip !== peer;

        return { ip, trusted: !isPrivateIp(ip) && !claimed };
    } catch (_) {
        return { ip: null, trusted: false };
    }
}

const num = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : d;
};

const CONFIG = {
    get enabled() { return process.env.LOGIN_THROTTLE_ENABLED !== 'false'; },
    get ipEnabled() { return process.env.LOGIN_THROTTLE_IP_ENABLED !== 'false'; },
    /** Consecutive failures against one identifier before it locks. */
    get accountMaxFailures() { return num(process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT, 10); },
    get accountWindowMs() { return num(process.env.LOGIN_FAILURE_WINDOW_MS, 15 * 60_000); },
    /**
     * Failures from one source address before it is blocked. Generous on
     * purpose — see the load-balancer note in the header. Raise it, or set
     * LOGIN_THROTTLE_IP_ENABLED=false, if your deployment cannot see real
     * client addresses.
     */
    get ipMaxFailures() { return num(process.env.LOGIN_MAX_FAILURES_PER_IP, 100); },
    get ipWindowMs() { return num(process.env.LOGIN_IP_FAILURE_WINDOW_MS, 15 * 60_000); },
    get ipBlockMs() { return num(process.env.LOGIN_IP_BLOCK_MS, 15 * 60_000); },
    /** Failures before each response starts being deliberately slowed. */
    get delayAfter() { return num(process.env.LOGIN_DELAY_AFTER_FAILURES, 3); },
    get delayStepMs() { return num(process.env.LOGIN_DELAY_STEP_MS, 400); },
    get delayMaxMs() { return num(process.env.LOGIN_DELAY_MAX_MS, 2000); },

    // ── Breadth controls (the password-spray half) ──
    /** Failures from one source before that source's responses are slowed. */
    get ipDelayAfter() { return num(process.env.LOGIN_IP_DELAY_AFTER_FAILURES, 10); },
    /**
     * DISTINCT identifiers failed from one source before its responses are
     * slowed. This is the spray signature specifically: forty accounts each
     * tried once looks like nothing to a per-account counter and nothing to a
     * raw failure count, but one source touching forty different usernames is
     * not a person who forgot their password.
     */
    get ipDistinctDelayAfter() { return num(process.env.LOGIN_IP_DELAY_AFTER_IDENTIFIERS, 5); },
    get ipDelayStepMs() { return num(process.env.LOGIN_IP_DELAY_STEP_MS, 250); },
    get ipDelayMaxMs() { return num(process.env.LOGIN_IP_DELAY_MAX_MS, 5000); },
    /**
     * Every failed sign-in takes at least this long, whatever path it took.
     * bcrypt cost differs between the config admin (12) and user rows (10), and
     * the dummy-hash compare matches the latter — so without a floor the one
     * documented account name still answered measurably slower than everything
     * else.
     *
     * A floor only equalises what it EXCEEDS. At 250 ms it did not: measured on
     * this hardware a cost-12 compare is ~233 ms and lands at ~327 ms end to
     * end, while every other failure was padded to ~260 ms — so the operator
     * account was still the slow one, by a smaller and much quieter margin than
     * before. That is the failure mode a floor is supposed to remove, so it now
     * clears the slowest real path with room to spare. Slower hardware, or a
     * higher bcrypt cost, needs this raised again — the test for it is a single
     * probe against the admin username next to one against a name that has
     * never existed.
     */
    get minFailureResponseMs() { return num(process.env.LOGIN_MIN_RESPONSE_MS, 450); },
    /**
     * How far ahead the per-source delay queue may reach before a failure is
     * refused outright instead of waited out. Without a ceiling the queue is a
     * connection-exhaustion lever: an attacker opens sockets faster than the
     * queue drains and every one of them sits there holding a handler.
     *
     * The refusal is transient — it clears as the queue drains — which is what
     * makes it safe on a shared load-balancer address in a way the persistent
     * per-IP block was not.
     */
    get queueMaxMs() { return num(process.env.LOGIN_QUEUE_MAX_MS, 30_000); },
};

/**
 * Escalating lock durations, indexed by how many times this identifier has
 * already been locked. A single fat-fingered user waits a minute; something
 * grinding away at one account is at an hour by the fourth round.
 */
const LOCK_STEPS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const LOCK_HISTORY_TTL_MS = 24 * 60 * 60 * 1000;

// ── Storage ───────────────────────────────────────────────────────────────────

/**
 * In-memory fallback. Bounded: an attacker spraying a million distinct
 * usernames must not be able to grow this without limit — that would turn a
 * defensive control into a memory-exhaustion vector.
 */
const MEM_MAX_KEYS = 50_000;
const _mem = new Map(); // key → { value: number, expiresAt: number }

function memSweep() {
    const now = Date.now();
    for (const [k, v] of _mem) {
        if (v.expiresAt <= now) _mem.delete(k);
    }
    if (_mem.size > MEM_MAX_KEYS) {
        // Oldest-expiring first — Map preserves insertion order, which for
        // fixed TTLs is close enough to expiry order.
        const excess = _mem.size - MEM_MAX_KEYS;
        let i = 0;
        for (const k of _mem.keys()) {
            _mem.delete(k);
            if (++i >= excess) break;
        }
    }
}
const _sweep = setInterval(memSweep, 60_000);
if (_sweep.unref) _sweep.unref();

function redis() {
    try {
        const { getRedis, redisHealthy } = require('../db');
        return redisHealthy() ? getRedis() : null;
    } catch (_) {
        return null;
    }
}

async function incr(key, ttlMs) {
    const r = redis();
    if (r) {
        try {
            // SET NX then INCR, not INCR then PEXPIRE. The old order left a
            // window — if the connection dropped between the two round-trips,
            // the counter survived with NO TTL and never expired, which for a
            // failure counter means a permanent lockout of that identifier.
            // SET .. PX .. NX creates the key already carrying its expiry and
            // is a no-op once it exists, so the counter can never outlive its
            // window no matter where a failure lands.
            await r.set(key, 0, 'PX', ttlMs, 'NX');
            return await r.incr(key);
        } catch (_) { /* fall through to memory */ }
    }
    const now = Date.now();
    const cur = _mem.get(key);
    if (!cur || cur.expiresAt <= now) {
        _mem.set(key, { value: 1, expiresAt: now + ttlMs });
        if (_mem.size > MEM_MAX_KEYS) memSweep();
        return 1;
    }
    cur.value += 1;
    return cur.value;
}

async function get(key) {
    const r = redis();
    if (r) {
        try {
            const v = await r.get(key);
            return v === null || v === undefined ? 0 : (parseInt(v, 10) || 0);
        } catch (_) { /* fall through to memory */ }
    }
    const cur = _mem.get(key);
    if (!cur || cur.expiresAt <= Date.now()) return 0;
    return cur.value;
}

/** Remaining lifetime in ms, or 0 when the key is absent/expired. */
async function ttl(key) {
    const r = redis();
    if (r) {
        try {
            const ms = await r.pttl(key);
            return ms > 0 ? ms : 0;
        } catch (_) { /* fall through to memory */ }
    }
    const cur = _mem.get(key);
    if (!cur) return 0;
    return Math.max(0, cur.expiresAt - Date.now());
}

async function set(key, value, ttlMs) {
    const r = redis();
    if (r) {
        try {
            await r.set(key, String(value), 'PX', ttlMs);
            return;
        } catch (_) { /* fall through to memory */ }
    }
    _mem.set(key, { value, expiresAt: Date.now() + ttlMs });
    if (_mem.size > MEM_MAX_KEYS) memSweep();
}

async function del(...keys) {
    const r = redis();
    if (r) {
        try { await r.del(...keys); } catch (_) { /* best-effort */ }
    }
    for (const k of keys) _mem.delete(k);
}

// ── The delay queue ───────────────────────────────────────────────────────────
//
// A delay is not a rate limit. The first version of this module answered a
// failed sign-in with `await sleep(delayMs)`, which holds nothing: N concurrent
// handlers register N independent timers that elapse SIMULTANEOUSLY, so a batch
// costs max(delay) and never sum(delay). A pentest measured it — eight parallel
// attempts came back in 0.67-1.42s where one serial attempt cost 5.1s, a 28x
// speed-up bought with nothing but sockets. Worse, the sleep ran AFTER the
// bcrypt compare, so it never even saved the server the cost of the guess.
//
// So the wait is now a RESERVATION rather than a nap. Each failed request takes
// the next slot on a per-source timeline and waits until that slot arrives.
// Eight parallel failures get slots at +5s, +10s, +15s... — the same total cost
// as if they had arrived one at a time, which is exactly the property a rate
// limit has and a delay does not.
//
// Deliberately NOT a mutex: nothing is held, so there is no head-of-line
// blocking and no lock to leak on an exception. And only FAILURES take slots —
// a successful sign-in never queues, so a tenant base sharing one load-balancer
// address is never made to wait behind an attack on someone else's password.
//
// The reservation is one synchronous read-modify-write with no await inside it,
// which is what makes it atomic on the in-memory path (the same property
// perUserRateLimit.checkMemory relies on).
const _slotBySource = new Map();

/**
 * Reserve this source's next delay slot.
 * @returns {{waitMs: number, overflow: boolean}} `overflow` means the queue
 *   already reaches past CONFIG.queueMaxMs, so the caller should refuse now
 *   rather than hold the connection.
 */
function reserveDelaySlot(sourceKey, delayMs) {
    if (!sourceKey || !(delayMs > 0)) return { waitMs: delayMs > 0 ? delayMs : 0, overflow: false };

    const now = Date.now();
    const queuedUntil = _slotBySource.get(sourceKey) || 0;
    const start = Math.max(now, queuedUntil);
    const waitMs = start - now;

    if (waitMs > CONFIG.queueMaxMs) {
        // Refuse without extending the queue — otherwise a flood pushes the
        // horizon further out for every later arrival, including legitimate ones.
        return { waitMs: 0, overflow: true };
    }

    _slotBySource.set(sourceKey, start + delayMs);
    if (_slotBySource.size > MEM_MAX_KEYS) sweepSlots(now);
    return { waitMs, overflow: false };
}

/** Drop timelines that have already drained; they carry no state worth keeping. */
function sweepSlots(now = Date.now()) {
    for (const [k, until] of _slotBySource) {
        if (until <= now) _slotBySource.delete(k);
    }
}
const _slotSweep = setInterval(() => sweepSlots(), 60_000);
if (_slotSweep.unref) _slotSweep.unref();

// ── Keys ──────────────────────────────────────────────────────────────────────

/**
 * Normalise the submitted identifier so `Admin`, `admin` and ` admin ` share one
 * counter — otherwise case alone multiplies an attacker's budget.
 */
function normalizeIdentifier(identifier) {
    return String(identifier || '').trim().toLowerCase().slice(0, 254);
}

const kAcctFail = (id) => `lt:af:${id}`;
const kAcctLock = (id) => `lt:al:${id}`;
const kAcctLockRounds = (id) => `lt:ar:${id}`;
const kIpFail = (ip) => `lt:if:${ip}`;
const kIpBlock = (ip) => `lt:ib:${ip}`;
/** How many DISTINCT identifiers this source has failed against. */
const kIpDistinct = (ip) => `lt:id:${ip}`;
/**
 * "Has this source already failed against this identifier in this window?"
 * A counter rather than a set, so it uses the same INCR-with-TTL primitive as
 * everything else here: the first increment returning 1 IS the "new identifier"
 * signal. Keeping one storage shape keeps the Redis and in-memory backends
 * interchangeable, which is what lets the whole module fail open safely.
 */
const kIpSeen = (ip, id) => `lt:is:${ip}:${id}`;

/** Fan-out counters — see recordFanOut. Namespaced so each route has its own. */
const kFanDistinct = (ns, ip) => `lt:fd:${ns}:${ip}`;
const kFanSeen = (ns, ip, target) => `lt:fs:${ns}:${ip}:${target}`;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Is this login attempt allowed to proceed to the credential check?
 *
 * Call BEFORE verifying the password — the whole point is to stop the attempt
 * from costing a bcrypt round.
 *
 * @param {object} req
 * @param {string} identifier the submitted username / e-mail, as typed
 * @returns {Promise<{allowed: boolean, retryAfterSec?: number, scope?: 'account'|'ip'}>}
 */
async function checkLoginAllowed(req, identifier) {
    if (!CONFIG.enabled) return { allowed: true };
    const id = normalizeIdentifier(identifier);
    const { ip } = sourceAddress(req);

    try {
        if (id) {
            const lockMs = await ttl(kAcctLock(id));
            if (lockMs > 0) {
                return { allowed: false, retryAfterSec: Math.ceil(lockMs / 1000), scope: 'account' };
            }
        }
        if (CONFIG.ipEnabled && ip) {
            const blockMs = await ttl(kIpBlock(ip));
            if (blockMs > 0) {
                return { allowed: false, retryAfterSec: Math.ceil(blockMs / 1000), scope: 'ip' };
            }
        }
    } catch (err) {
        // Fail open — never let the throttle become the outage.
        log.warn('[LoginThrottle] check failed, allowing attempt:', err.message);
    }
    return { allowed: true };
}

/**
 * Record a failed authentication and decide how much to slow the response.
 *
 * The returned delay is applied by the caller BEFORE it answers, so an attacker
 * grinding one account pays an increasing cost per guess long before the hard
 * lock lands. It is symmetric across existing and non-existing accounts by
 * construction (the key is the submitted string), so it adds no oracle.
 *
 * @returns {Promise<{delayMs: number, locked: boolean, retryAfterSec: number}>}
 */
async function recordLoginFailure(req, identifier) {
    if (!CONFIG.enabled) return { delayMs: 0, locked: false, retryAfterSec: 0 };
    const id = normalizeIdentifier(identifier);
    const { ip, trusted } = sourceAddress(req);

    try {
        let delayMs = 0;
        let locked = false;
        let retryAfterSec = 0;

        if (id) {
            const fails = await incr(kAcctFail(id), CONFIG.accountWindowMs);
            if (fails > CONFIG.delayAfter) {
                delayMs = Math.min(CONFIG.delayMaxMs, (fails - CONFIG.delayAfter) * CONFIG.delayStepMs);
            }
            if (fails >= CONFIG.accountMaxFailures) {
                // How many times has this identifier been locked recently?
                // Escalate rather than handing out the same 60 seconds forever.
                const rounds = await incr(kAcctLockRounds(id), LOCK_HISTORY_TTL_MS);
                const lockMs = LOCK_STEPS_MS[Math.min(rounds - 1, LOCK_STEPS_MS.length - 1)];
                await set(kAcctLock(id), 1, lockMs);
                await del(kAcctFail(id));   // the lock replaces the counter
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
                const lockTtl = await ttl(kAcctLock(id));
                if (lockTtl > 0) {
                    locked = true;
                    retryAfterSec = Math.ceil(lockTtl / 1000);
                }
            }
        }

        // ── Breadth: what is this SOURCE doing, across all identifiers? ──
        // Runs whether or not the address is trustworthy. An untrusted address
        // only ever earns a delay (see sourceAddress); a trusted one can still
        // be blocked outright.
        if (CONFIG.ipEnabled && ip) {
            const ipFails = await incr(kIpFail(ip), CONFIG.ipWindowMs);

            // Count this identifier once per window per source.
            let distinct = 0;
            if (id) {
                const seen = await incr(kIpSeen(ip, id), CONFIG.ipWindowMs);
                distinct = seen === 1
                    ? await incr(kIpDistinct(ip), CONFIG.ipWindowMs)
                    : await get(kIpDistinct(ip));
            }

            const overFailures = Math.max(0, ipFails - CONFIG.ipDelayAfter);
            const overDistinct = Math.max(0, distinct - CONFIG.ipDistinctDelayAfter);
            const ipDelayMs = Math.min(
                CONFIG.ipDelayMaxMs,
                (overFailures + overDistinct * 2) * CONFIG.ipDelayStepMs,
            );
            // The two delays are not additive — an attacker should pay the
            // worse of the two, not the sum, so a legitimate user caught in a
            // shared bucket never stacks penalties.
            if (ipDelayMs > delayMs) delayMs = ipDelayMs;

            if (trusted && ipFails >= CONFIG.ipMaxFailures) {
                await set(kIpBlock(ip), 1, CONFIG.ipBlockMs);
                await del(kIpFail(ip));
                locked = true;
                retryAfterSec = Math.max(retryAfterSec, Math.ceil(CONFIG.ipBlockMs / 1000));
                recordAuthEvent({ kind: 'login_lockout', status: 'blocked' });
                log.warn(`[LoginThrottle] source address blocked for ${Math.round(CONFIG.ipBlockMs / 1000)}s after ${ipFails} failed attempts.`);
            } else if (!trusted && (overFailures > 0 || overDistinct > 0)) {
                recordAuthEvent({ kind: 'login_spray', status: 'blocked' });
            }
        }

        // Turn the computed cost into a slot on this source's timeline, so N
        // parallel failures pay N x delay between them instead of all paying it
        // at once. Keyed on the source, not the identifier: spraying is one
        // source against many names, and per-identifier queues would each be
        // empty. Falls back to the identifier when there is no usable address,
        // so the cost never silently disappears.
        if (delayMs > 0 && !locked) {
            const slot = reserveDelaySlot(ip || `id:${id}`, delayMs);
            if (slot.overflow) {
                // The queue already reaches past the ceiling. Refuse now rather
                // than hold the socket — transient, and it clears as the queue
                // drains, so it is not the persistent block a shared egress
                // address could never safely be given.
                locked = true;
                retryAfterSec = Math.max(retryAfterSec, Math.ceil(CONFIG.queueMaxMs / 1000));
                delayMs = 0;
                recordAuthEvent({ kind: 'login_queue_full', status: 'blocked' });
            } else {
                delayMs = slot.waitMs;
            }
        }

        return { delayMs, locked, retryAfterSec };

    } catch (err) {
        log.warn('[LoginThrottle] failure bookkeeping failed:', err.message);
        return { delayMs: 0, locked: false, retryAfterSec: 0 };
    }
}

/**
 * Breadth control for routes that ACT ON A TARGET rather than authenticate one:
 * forgot-password, resend-verification, pending-signup.
 *
 * Those already cap requests per target address (3 an hour, so one mailbox
 * cannot be flooded) and per source IP. The per-IP cap is skipped for untrusted
 * peers, deliberately — see sourceAddress — which leaves the shape a retest
 * found: forty requests to forty DIFFERENT addresses sail through, because no
 * single target reaches its cap and the source limiter is not running.
 *
 * So count distinct targets per source and slow the source down. Delay, never
 * block: the whole reason the per-IP cap steps aside is that the address may be
 * a load balancer shared by every customer, and a mail-sending endpoint is not
 * worth locking a tenant base out of. Keyed on the SUBMITTED string, never on a
 * resolved account, so it cannot become an existence oracle.
 *
 * @returns {Promise<{delayMs: number, distinct: number}>}
 */
const FANOUT = {
    get windowMs() { return num(process.env.AUTH_FANOUT_WINDOW_MS, 60 * 60_000); },
    get distinctAfter() { return num(process.env.AUTH_FANOUT_DISTINCT_AFTER, 5); },
    get stepMs() { return num(process.env.AUTH_FANOUT_DELAY_STEP_MS, 400); },
    get maxMs() { return num(process.env.AUTH_FANOUT_DELAY_MAX_MS, 5000); },
};

async function recordFanOut(req, namespace, target) {
    if (!CONFIG.enabled || !CONFIG.ipEnabled) return { delayMs: 0, distinct: 0 };
    const { ip } = sourceAddress(req);
    const key = normalizeIdentifier(target);
    if (!ip || !key) return { delayMs: 0, distinct: 0 };

    try {
        // Long keys are hashed rather than embedded: an e-mail address is
        // attacker-controlled and up to 254 characters.
        const slot = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
        const seen = await incr(kFanSeen(namespace, ip, slot), FANOUT.windowMs);
        const distinct = seen === 1
            ? await incr(kFanDistinct(namespace, ip), FANOUT.windowMs)
            : await get(kFanDistinct(namespace, ip));

        const over = Math.max(0, distinct - FANOUT.distinctAfter);
        const cost = Math.min(FANOUT.maxMs, over * FANOUT.stepMs);
        if (over === 0) return { delayMs: 0, distinct };

        recordAuthEvent({ kind: 'auth_fanout', status: 'blocked' });
        // Same reservation as the login path, and for the same reason: a caller
        // that fires its whole address list at once would otherwise pay one
        // delay for the batch instead of one per request. Its own timeline, so
        // mail fan-out and login spraying do not queue behind each other.
        const reserved = reserveDelaySlot(`fan:${namespace}:${ip}`, cost);
        return { delayMs: reserved.waitMs, distinct, overflow: reserved.overflow };
    } catch (err) {
        log.warn('[LoginThrottle] fan-out bookkeeping failed:', err.message);
        return { delayMs: 0, distinct: 0 };
    }
}

/** A successful authentication clears the identifier's failure counter. */
async function recordLoginSuccess(req, identifier) {
    if (!CONFIG.enabled) return;
    const id = normalizeIdentifier(identifier);
    if (!id) return;
    try {
        await del(kAcctFail(id), kAcctLock(id));
        // The escalation history is deliberately NOT cleared: an attacker who
        // eventually guesses right should not also get to reset the ladder for
        // the next account they try from the same identifier.
    } catch (err) {
        log.warn('[LoginThrottle] success bookkeeping failed:', err.message);
    }
}

/** Send the 429 for a refused attempt. One shape for both scopes, on purpose. */
function denyLogin(res, retryAfterSec) {
    const retryAfter = Math.max(1, retryAfterSec || 60);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({
        error: 'Too many failed sign-in attempts. Please wait and try again.',
        code: 'too_many_attempts',
        retryAfter,
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hold a failed sign-in until it has taken at least the configured floor.
 *
 * The dummy-hash compare in loginRoutes equalises the big difference (found
 * account vs not found). This flattens what is left: the built-in admin row is
 * hashed at bcrypt cost 12 while every user row uses cost 10, an account with a
 * password costs a real compare while one without costs the dummy, and a
 * database lookup that hits differs from one that misses. None of those is a
 * ninety-fold gap any more, but "no measurable difference" is a much easier
 * property to keep true than "a small measurable difference", and it costs a
 * quarter-second on a wrong password.
 *
 * Call with the timestamp taken at the very start of the handler.
 */
async function padFailureResponse(startedAt) {
    const floor = CONFIG.minFailureResponseMs;
    if (!floor || !startedAt) return;
    const remaining = floor - (Date.now() - startedAt);
    if (remaining > 0) await sleep(remaining);
}

/** Test/ops helper — drop all throttle state for one identifier. */
async function clearIdentifier(identifier) {
    const id = normalizeIdentifier(identifier);
    if (!id) return;
    await del(kAcctFail(id), kAcctLock(id), kAcctLockRounds(id));
}

/** Test helper — wipe the in-memory store between cases. */
function _resetMemory() {
    _mem.clear();
    _slotBySource.clear();
}

module.exports = {
    checkLoginAllowed,
    recordLoginFailure,
    recordLoginSuccess,
    recordFanOut,
    reserveDelaySlot,
    denyLogin,
    clearIdentifier,
    normalizeIdentifier,
    padFailureResponse,
    sleep,
    CONFIG,
    _resetMemory,
};
