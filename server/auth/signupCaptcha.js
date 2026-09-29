// @typecheck
/**
 * signupCaptcha.js — bot protection for the anonymous signup surface.
 *
 * A pentest created a fully functional organisation and an org-admin user
 * anonymously, in one request, with no e-mail verification, no approval step,
 * no rate limiting and a password of `password`. Thirty concurrent signups
 * produced zero 429s. On this product an unlimited tenant factory is not just
 * database growth: every tenant carries an AI/LLM quota, and that quota costs
 * real money.
 *
 * Rate limiting (utils/perUserRateLimit, mounted in loginRoutes) raises the cost
 * of that per source address. A CAPTCHA raises it per REQUEST, which is the part
 * an attacker cannot solve by renting more addresses.
 *
 * OFF UNTIL CONFIGURED — and that is not a hedge. Bee Flow ships self-hosted and
 * air-gapped; a hard dependency on Cloudflare or hCaptcha would make signup
 * impossible on installs that have no outbound internet, and a CAPTCHA that is
 * always enabled with no key is just a broken signup form. So: configure a
 * provider and a secret, and it is enforced; leave it unset, and this module is
 * a no-op that says so at boot.
 *
 * Once configured it FAILS CLOSED. An operator who turned this on did so
 * because they are being abused, and "the verifier was briefly unreachable so we
 * let everyone through" is how a control becomes decorative. Deployments that
 * would rather keep signups flowing can set SIGNUP_CAPTCHA_FAIL_OPEN=true.
 *
 * ENV
 *   SIGNUP_CAPTCHA_PROVIDER   'turnstile' | 'hcaptcha' | 'recaptcha'  (unset = off)
 *   SIGNUP_CAPTCHA_SECRET     provider secret key (server-side, never exposed)
 *   SIGNUP_CAPTCHA_SITE_KEY   public site key — surfaced by /auth/setup-status
 *                             so the SPA can render the widget
 *   SIGNUP_CAPTCHA_FAIL_OPEN  'true' to allow signups when the verifier is down
 *
 * The client sends the widget's token as `captchaToken` in the signup body.
 *
 * No request schema lives here: this file declares no route. The captcha token
 * it reads belongs to the signup routes that mount it, whose schemas name it.
 */

const VERIFY_URLS = {
    turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    hcaptcha: 'https://api.hcaptcha.com/siteverify',
    recaptcha: 'https://www.google.com/recaptcha/api/siteverify',
};

const { clientIp } = require('./signupGuards');
const log = require('../telemetry/log');

function provider() {
    const p = String(process.env.SIGNUP_CAPTCHA_PROVIDER || '').trim().toLowerCase();
    return VERIFY_URLS[p] ? p : null;
}

/** Configured means: a known provider AND a secret. Half-configured is off. */
function isEnabled() {
    return !!(provider() && String(process.env.SIGNUP_CAPTCHA_SECRET || '').trim());
}

/**
 * What the SPA needs to render the widget. Safe to expose anonymously — the site
 * key is public by design; the secret never leaves this process.
 */
function publicConfig() {
    if (!isEnabled()) return { enabled: false, provider: null, siteKey: null };
    return {
        enabled: true,
        provider: provider(),
        siteKey: String(process.env.SIGNUP_CAPTCHA_SITE_KEY || '').trim() || null,
    };
}

function failOpen() {
    return String(process.env.SIGNUP_CAPTCHA_FAIL_OPEN || '').toLowerCase() === 'true';
}

/**
 * Verify a widget token.
 *
 * @param {string} token  the `captchaToken` from the request body
 * @param {object} [req]  used only to forward the remote IP, which the providers
 *                        accept as an optional extra signal
 * @returns {Promise<{ok: boolean, error?: string, code?: string}>}
 */
async function verifyCaptcha(token, req) {
    if (!isEnabled()) return { ok: true };

    if (typeof token !== 'string' || !token.trim()) {
        return { ok: false, code: 'captcha_required', error: 'Please complete the verification challenge.' };
    }

    const name = provider();
    const body = new URLSearchParams({
        secret: String(process.env.SIGNUP_CAPTCHA_SECRET || '').trim(),
        response: token.trim(),
    });
    try {
        const ip = req ? clientIp(req) : null;
        if (ip) body.set('remoteip', ip);
    } catch (_) { /* optional signal */ }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const resp = await fetch(VERIFY_URLS[name], {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
            signal: controller.signal,
        });
        if (!resp.ok) throw new Error(`verifier returned HTTP ${resp.status}`);
        const data = /** @type {{ success?: boolean, [key: string]: any }} */ (await resp.json());
        if (data?.success === true) return { ok: true };
        // Never echo the provider's error codes to the caller — they distinguish
        // "token already used" from "wrong secret", which tells an attacker
        // whether the operator's configuration is broken.
        log.warn(`[SignupCaptcha] ${name} rejected a token:`, Array.isArray(data?.['error-codes']) ? data['error-codes'].join(',') : 'unknown');
        return { ok: false, code: 'captcha_failed', error: 'Verification failed. Please try again.' };
    } catch (err) {
        log.error(`[SignupCaptcha] ${name} verification unavailable:`, err.message);
        if (failOpen()) {
            log.error('[SignupCaptcha] SECURITY: SIGNUP_CAPTCHA_FAIL_OPEN=true — allowing an unverified signup through.');
            return { ok: true };
        }
        return { ok: false, code: 'captcha_unavailable', error: 'Verification is temporarily unavailable. Please try again shortly.' };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Express middleware form, for routes whose only captcha need is "reject before
 * doing any work".
 */
function requireCaptcha(field = 'captchaToken') {
    return async function captchaMiddleware(req, res, next) {
        if (!isEnabled()) return next();
        const result = await verifyCaptcha(req.body?.[field], req);
        if (!result.ok) {
            return res.status(400).json({ error: result.error, code: result.code });
        }
        next();
    };
}

let _announced = false;
/** Log the effective state once at boot so the setting is never silently off. */
function announce() {
    if (_announced) return;
    _announced = true;
    if (isEnabled()) {
        log.info(`[SignupCaptcha] enabled (${provider()}), fail-${failOpen() ? 'open' : 'closed'}`);
    } else if (provider()) {
        log.warn('[SignupCaptcha] SIGNUP_CAPTCHA_PROVIDER is set but SIGNUP_CAPTCHA_SECRET is empty — signup CAPTCHA is NOT enforced.');
    }
}

module.exports = { isEnabled, publicConfig, verifyCaptcha, requireCaptcha, announce, provider };
