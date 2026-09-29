// OpenObserve RUM + browser-logs — privacy-hardened, prod-only, kill-switched.
//
// Design constraints (Bee Flow is a zero-knowledge, GDPR-first product):
//   * NO-OP unless a client token is present AND this is a real production
//     build. Dev / self-host / preview builds never beacon.
//   * Session Replay is OFF by default (sessionReplaySampleRate: 0). If ever
//     enabled it runs mask-all; see the masking notes below + docs.
//   * Never regress the secret-redaction guarantee: every log message, error
//     message and resource URL is passed through redactSecrets() before send.
//   * Never runs inside the public /chat/<id> embed (third-party origin).
//   * On the public marketing site, additionally consent-gated: nothing
//     beacons to the collector before the visitor accepts cookies.
//
// Public API:
//   initOpenObserve()      — call once, BEFORE ReactDOM.render (see main.jsx).
//   setTelemetryView(name) — optional low-cardinality view name.
//   isTelemetryEnabled()   — for callers that want to branch.

/* The two SDKs are loaded DYNAMICALLY, inside initOpenObserve(), after the
   env gate has already said yes.

   Statically imported they compiled to ~220 modules sitting in the entry
   chunk — the single largest thing in it — downloaded and parsed by every
   visitor before React mounted. That cost is pure waste in the two cases that
   matter most: any dev build (the gate returns false on `!env.PROD`) and any
   self-hosted or marketing pageview where no client token was ever baked in.
   A privacy product should not be shipping an unused RUM agent to readers of
   its own pricing page.

   The gate is entirely build-time env plus `window.location`, so it is cheap
   to evaluate before deciding to fetch anything. */
let openobserveLogs = null;
let openobserveRum = null;
import { consentAccepted } from '../marketing/components/consent';
import { APP_BUILD_SHA } from '../utils/appVersion';
import { redactSecrets } from '../utils/clientErrorReporter';
import { isPublicMarketingPath } from '../utils/cmsPublicRouting';

const env = import.meta.env;

// ── Runtime settings, written by the image at container start ────────
// docker-entrypoint.d/19-beeflow-runtime-config.sh writes /beeflow-runtime.js
// and index.html loads it (classic script) before this module evaluates.
// Absent in dev, in a non-container build, and on any deployment still running
// an older image — all three are handled below.
const RUNTIME = (() => {
    try {
        return (typeof window !== 'undefined' && window.__BEEFLOW_RUNTIME__?.telemetry) || null;
    } catch { return null; /* SSR / locked-down window */ }
})();

// ── Config from build-time env (VITE_*). Baked into the bundle at build. ──
const APPLICATION_ID = env.VITE_OPENOBSERVE_APPLICATION_ID || '';
const ORG            = env.VITE_OPENOBSERVE_ORG || 'default';
const SERVICE        = env.VITE_OPENOBSERVE_SERVICE || 'agent-hub';
const OO_ENV         = env.VITE_OPENOBSERVE_ENV || (env.PROD ? 'production' : 'development');
// A deployment may point the beacon at its own collector without a rebuild;
// runtime wins, empty means "no runtime opinion, keep what the build carried".
const CLIENT_TOKEN   = (RUNTIME?.clientToken || '') || env.VITE_OPENOBSERVE_CLIENT_TOKEN || '';
// No default collector: an image without a site configured never beacons.
const SITE           = (RUNTIME?.site || '') || env.VITE_OPENOBSERVE_SITE || '';

// ── The switch, and why it moved ─────────────────────────────────────
// This used to be build-time only, and it defaulted to ON. Both halves were
// wrong for an image that other people run:
//
//   * build-time means a self-hosted operator could not turn the beacon off
//     without building their own frontend image. For a product sold on "your
//     data stays where you put it", "rebuild it yourself" is not an off switch.
//   * defaulting to ON makes the quiet state the one you have to ask for. On a
//     privacy product the safe state is the one you get by doing nothing.
//
// So it is opt-in now, and readable at runtime:
//   1. runtime file present → it decides, both ways. An operator who set
//      BEEFLOW_TELEMETRY_ENABLED gets exactly what they asked for.
//   2. runtime file absent  → fall back to the build-time flag, which now
//      defaults to OFF. Absent configuration is not consent.
const ENABLE_FLAG = RUNTIME
    ? RUNTIME.enabled === true
    : String(env.VITE_OPENOBSERVE_ENABLE ?? 'false') === 'true';

// Sampling. 100% sessions (self-hosted, EU box, low traffic → keep them all).
// Replay OFF: 0. Raise to e.g. 20 later to record 20% of sessions, mask-all.
const SESSION_SAMPLE_RATE = Number(env.VITE_OPENOBSERVE_SESSION_SAMPLE_RATE ?? 100);
const SESSION_REPLAY_SAMPLE_RATE = Number(env.VITE_OPENOBSERVE_REPLAY_SAMPLE_RATE ?? 0);

let started = false;

// Marketing-vs-app split: on the public marketing surface (anonymous visitor
// on a CMS page, legal doc or demo) RUM is marketing-tracking and must wait
// for the CookieBanner decision. In-app surfaces (/app, /login, hosted forms
// — product telemetry for signed-in users) keep the existing gates and are
// deliberately NOT consent-gated here.
function inPublicMarketingContext() {
    try {
        return isPublicMarketingPath(window.location.pathname);
    } catch { return false; /* SSR guard */ }
}

// Drop-condition shared by both beforeSend hooks: on the public marketing
// surface, no (remaining) consent → discard the event.
function consentWithheld() {
    return inPublicMarketingContext() && !consentAccepted();
}

let consentWatched = false;

// Public-site consent transitions: same-tab choices arrive via CookieBanner's
// `bf-cookie-consent` event, other tabs via the native `storage` event.
// Acceptance re-runs init so telemetry starts from that moment — whatever
// happened before it is accepted loss, never buffered for later. Withdrawal
// ends the RUM session; anything the SDK still emits afterwards is dropped by
// the beforeSend guards below.
function watchConsent() {
    if (consentWatched) return;
    consentWatched = true;
    const onChange = () => {
        if (consentAccepted()) { initOpenObserve(); return; }
        if (started && openobserveRum &&
            typeof openobserveRum.stopSession === 'function') {
            try { openobserveRum.stopSession(); } catch { /* noop */ }
        }
    };
    try {
        window.addEventListener('bf-cookie-consent', onChange);
        window.addEventListener('storage', onChange);
    } catch { /* SSR guard */ }
}

// Gate: token present AND production build AND flag on AND not the public embed.
function shouldInit() {
    if (started) return false;
    if (!CLIENT_TOKEN || !APPLICATION_ID || !SITE) return false; // no creds or collector → no-op
    if (!env.PROD) return false;                           // dev builds never beacon
    if (!ENABLE_FLAG) return false;                        // explicit kill switch
    try {
        if (window.location.pathname.startsWith('/chat/')) return false; // 3rd-party embed
    } catch { /* SSR guard */ }
    return true;
}

// allowedTracingUrls: same-origin in prod; add VITE_API_URL when it is an
// absolute URL (self-host on a separate API domain). This injects W3C
// traceparent headers into matched fetch/XHR to connect RUM → backend traces.
function tracingUrls() {
    const urls = [window.location.origin];
    const api = env.VITE_API_URL;
    if (api && /^https?:\/\//i.test(api)) {
        try { urls.push(new URL(api).origin); } catch { /* ignore */ }
    }
    return Array.from(new Set(urls));
}

// beforeSend hooks — last-line redaction so tokens/keys never leave the browser.
// They double as the consent kill switch: returning false discards the event
// before batching, so a withdrawal on the public site stops every request even
// though the SDK itself cannot be torn down once initialised.
function scrubRumEvent(event) {
    if (consentWithheld()) return false;
    try {
        if (event?.error?.message) event.error.message = redactSecrets(event.error.message);
        if (event?.error?.stack)   event.error.stack   = redactSecrets(event.error.stack);
        if (event?.view?.url)      event.view.url      = redactSecrets(event.view.url);
        if (event?.resource?.url)  event.resource.url  = redactSecrets(event.resource.url);
    } catch { /* never break telemetry */ }
    return true;
}
function scrubLog(log) {
    if (consentWithheld()) return false;
    try { if (log?.message) log.message = redactSecrets(log.message); } catch { /* noop */ }
    return true;
}

export async function initOpenObserve() {
    if (!shouldInit()) return;
    if (inPublicMarketingContext()) {
        watchConsent();
        if (!consentAccepted()) return; // deferred until acceptance (see watchConsent)
    }
    started = true;

    try {
        const [logsMod, rumMod] = await Promise.all([
            import('@openobserve/browser-logs'),
            import('@openobserve/browser-rum'),
        ]);
        openobserveLogs = logsMod.openobserveLogs;
        openobserveRum = rumMod.openobserveRum;
    } catch (e) {
        // Chunk fetch failed (offline, blocked, cache miss on a stale deploy).
        // Telemetry must never break the app.
        started = false;
        try { console.warn('[openobserve] sdk load failed:', e && e.message); } catch { /* noop */ }
        return;
    }

    const common = {
        clientToken: CLIENT_TOKEN,
        site: SITE,
        organizationIdentifier: ORG,       // SDK key is organizationIdentifier, not "org"
        service: SERVICE,
        env: OO_ENV,
        version: APP_BUILD_SHA,            // per-deploy version (git sha)
        apiVersion: 'v1',
        insecureHTTP: false,               // force HTTPS to the collector
    };

    try {
        openobserveRum.init({
            ...common,
            applicationId: APPLICATION_ID,
            sessionSampleRate: SESSION_SAMPLE_RATE,
            sessionReplaySampleRate: SESSION_REPLAY_SAMPLE_RATE, // 0 → replay OFF
            defaultPrivacyLevel: 'mask',       // mask ALL text/inputs if replay ever on
            trackResources: true,
            trackLongTasks: true,
            trackUserInteractions: true,
            allowedTracingUrls: tracingUrls(),
            beforeSend: scrubRumEvent,
        });

        openobserveLogs.init({
            ...common,
            forwardErrorsToLogs: true,             // window.onerror / unhandledrejection → logs
            forwardConsoleLogs: ['error', 'warn'], // NOT 'log'/'info' (chat text could leak)
            forwardReports: [],                    // no CSP/deprecation report forwarding
            beforeSend: scrubLog,
        });

        // Session replay stays OFF while sampleRate is 0. Only starts recording
        // when the rate is raised (documented enable path). Safe to call always.
        if (SESSION_REPLAY_SAMPLE_RATE > 0 &&
            typeof openobserveRum.startSessionReplayRecording === 'function') {
            openobserveRum.startSessionReplayRecording();
        }
    } catch (e) {
        // Telemetry must never break the app.
        started = false;
        try { console.warn('[openobserve] init failed:', e && e.message); } catch { /* noop */ }
    }
}

// Optional: give RUM a low-cardinality view name instead of raw pathnames
// that carry agent/notebook IDs.
export function setTelemetryView(name) {
    // `started` is set before the dynamic import resolves, so the null check on
    // the SDK matters: a view change during that window is dropped rather than
    // throwing.
    if (!started || !name || !openobserveRum) return;
    try { openobserveRum.startView({ name }); } catch { /* noop */ }
}

export function isTelemetryEnabled() { return started; }
