/**
 * AI Config — per-user settings: integration credentials (Fireflies,
 * YouTrack, AFAS, NMBRS, vPlan, …), app enablement, EU-mode flags, Simple
 * Mode and Learning Center progress.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * POST /user-settings is a partial update: only the keys present are
 * written. Its body is a zod schema, `.strict()`, and EVERY check now runs
 * before the first write. The handler used to write field by field and
 * refuse half-way, so a refused save left a half-applied one behind — an
 * NMBRS form whose token was rejected had already switched `nmbrsApiMode`
 * to rest, and an AFAS form whose token was rejected had already stored the
 * new member number beside the old token.
 *
 * What the hand-rolled reads let through, each under a 200 "success":
 *
 *   - `memoryEnabled: "false"` was stored as TRUE (`!== false`): memory
 *     stayed on for someone who had just switched it off;
 *   - `simpleMode` / `hasSeenIntroTour` as the text "false" read as true;
 *   - `learningProgressReset: "true"` reset nothing;
 *   - a `learningPath` outside the list (`'Builder'`) was dropped;
 *   - `enabledApps` was stored as whatever arrived. As the string "gmail"
 *     the tool gate matched app ids as SUBSTRINGS, and the headless resolver
 *     (enabledIntegrations.parseList) read it as null — "every app enabled"
 *     for routines of someone who had narrowed it to one;
 *   - `signrequestSubdomain` was interpolated raw into
 *     `https://${subdomain}.signrequest.com`, so `host:port/x?` sent the
 *     user's token to any https host the server can reach. It is one DNS
 *     label now, like the AFAS and NMBRS subdomains beside it;
 *   - `youtrackUrl` could be anything; it has to be an http(s) address now.
 *     Its HOST is deliberately not checked: a YouTrack on the company
 *     network is a normal self-hosted setup;
 *   - a misspelled key (`firefliesApikey`) was ignored.
 *
 * `userEuModeEnabled` is named in the schema only to refuse it with a
 * sentence: EU mode lives in the Privacy Shield panel (see below).
 */

const express = require('express');
const { z } = require('zod');
const log = require('../../../telemetry/log');
const router = express.Router();
const configStore = require('../../../stores/configStore');
const { normalizeAfasToken } = require('../../../integrations/afasTools');
const { SUBDOMAIN_RE: NMBRS_SUBDOMAIN_RE, TOKEN_RE: NMBRS_TOKEN_RE, EMAIL_RE: NMBRS_EMAIL_RE } = require('../../../integrations/nmbrsTools');
const { API_KEY_RE: VPLAN_API_KEY_RE, API_ENV_RE: VPLAN_API_ENV_RE } = require('../../../integrations/vplanTools');
const { sanitizeLearningProgress, mergeLearningProgress } = require('../../../learning/progressValidation');
const { readServerProgress } = require('../../../learning/certificates');
const { requireAuth } = require('../../../auth/permissions');
const { orgScope } = require('../../../auth/orgScope');
const { memoryEnabledKey, isMemoryEnabledForUser } = require('../../../core/memory/memoryPolicy');
const { validate } = require('../../../core/http/validate');

// One DNS label — the team part of <team>.signrequest.com, nothing else.
const SIGNREQUEST_SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const LEARNING_PATHS = ['everyday', 'builder', 'admin', 'skipped', ''];

/** Text, trimmed; '' or null disconnects. */
const credential = (label) => z.string({ invalid_type_error: `${label} must be text.` })
    .trim().max(4096, `${label} is at most 4096 characters.`).nullable();
/** Text that must match `re` unless it is '' (disconnect). */
const shaped = (re, message) => z.string({ invalid_type_error: message })
    .trim().refine((v) => v === '' || re.test(v), message).nullable();
/** One of `values`, case-insensitive; '' clears it. */
const oneOf = (values, message) => z.string({ invalid_type_error: message })
    .trim().toLowerCase().pipe(z.enum(values, { errorMap: () => ({ message }) })).nullable();
const flag = (name) => z.boolean({ invalid_type_error: `${name} is true or false.` });

function isHttpUrl(value) {
    try {
        const { protocol } = new URL(value);
        return protocol === 'https:' || protocol === 'http:';
    } catch (_) {
        return false;
    }
}

const AFAS_NUMBER_TEXT = 'AFAS member number must be digits only.';
const AFAS_TOKEN_TEXT = 'AFAS token is not a valid AppConnector token. Paste the token XML or its hex data.';
const YOUTRACK_URL_TEXT = 'The YouTrack URL is the address of your YouTrack, like https://yourcompany.youtrack.cloud.';
const APPS_TEXT = 'enabledApps is a list of app ids, or null for all apps.';

const UserSettingsBody = z.object({
    firefliesApiKey: credential('The Fireflies API key'),
    gammaApiKey: credential('The Gamma API key'),
    youtrackUrl: z.string({ invalid_type_error: YOUTRACK_URL_TEXT }).trim().max(2048, YOUTRACK_URL_TEXT)
        .refine((v) => v === '' || isHttpUrl(v), YOUTRACK_URL_TEXT).nullable(),
    youtrackToken: credential('The YouTrack token'),
    signrequestSubdomain: shaped(SIGNREQUEST_SUBDOMAIN_RE, 'The SignRequest subdomain is just your team name (e.g. "your-team"), no dots or slashes.'),
    signrequestToken: credential('The SignRequest token'),
    // AFAS Profit — the member number forms the API URL's subdomain (SSRF
    // guard) and the token is stored in canonical XML form. A number is
    // taken as its digits, as String() did before.
    afasMemberNumber: z.preprocess((v) => (typeof v === 'number' ? String(v) : v),
        shaped(/^\d{1,10}$/, AFAS_NUMBER_TEXT)),
    afasToken: z.string({ invalid_type_error: AFAS_TOKEN_TEXT }).nullable().transform((v, ctx) => {
        if (!v) return '';
        const value = normalizeAfasToken(v);
        if (!value) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: AFAS_TOKEN_TEXT });
            return z.NEVER;
        }
        return value;
    }),
    afasEnvType: oneOf(['', 'production', 'test', 'accept'], 'AFAS environment type must be production, test or accept.'),
    // NMBRS (read-only). The subdomain forms the SOAP Domain / REST tenant
    // (SSRF-relevant), the token/email travel in auth headers.
    nmbrsApiMode: oneOf(['', 'soap', 'rest'], 'NMBRS API mode must be soap or rest.'),
    nmbrsSubdomain: shaped(NMBRS_SUBDOMAIN_RE, 'NMBRS subdomain is invalid — use just the tenant name (e.g. "mycompany"), no dots or slashes.'),
    nmbrsEmail: shaped(NMBRS_EMAIL_RE, 'NMBRS login email is invalid.'),
    nmbrsToken: shaped(NMBRS_TOKEN_RE, 'NMBRS token is invalid — paste the API token / bearer token with no spaces.'),
    nmbrsEnv: oneOf(['', 'production', 'sandbox'], 'NMBRS environment must be production or sandbox.'),
    // vPlan (read-only) — both travel in request headers (X-Api-Key /
    // X-Api-Env), so the shape check is the header-injection guard.
    vplanApiKey: shaped(VPLAN_API_KEY_RE, 'vPlan API key is invalid — paste the key from vPlan → Settings → Developers, with no spaces.'),
    vplanApiEnv: shaped(VPLAN_API_ENV_RE, 'vPlan environment is invalid — paste the API env shown next to the key in vPlan, with no spaces.'),
    enabledApps: z.array(z.string({ invalid_type_error: APPS_TEXT }).trim().min(1, APPS_TEXT).max(100, APPS_TEXT),
        { invalid_type_error: APPS_TEXT }).max(500, APPS_TEXT).nullable(),
    simpleMode: flag('simpleMode'),
    memoryEnabled: flag('memoryEnabled'),
    hasSeenIntroTour: flag('hasSeenIntroTour'),
    learningProgress: z.record(z.unknown(), { invalid_type_error: 'learningProgress is a map of lesson ids.' }).nullable(),
    learningProgressReset: flag('learningProgressReset'),
    learningPath: z.enum(LEARNING_PATHS, { errorMap: () => ({ message: "learningPath is 'everyday', 'builder', 'admin', 'skipped' or ''." }) }),
    userEuModeEnabled: z.never({ errorMap: () => ({ message: 'EU mode is set in Settings → Privacy Shield; this endpoint no longer changes it.' }) }),
}).partial().strict();

// ─── Per-User Settings (Fireflies key etc.) ──────────────────────

router.get('/user-settings', requireAuth, async (req, res) => {
    const userId = req.session.user.id;

    // BFSF-255, second half: a password-account user connects Google/Microsoft
    // through Settings → Connections, which writes an encrypted vault
    // credential but leaves the session without an oauthProvider.
    // getIntegrationTools() already hydrates the session from that vault before
    // deciding which tools exist — this endpoint did not, so it reported
    // isGoogleUser=false while the model was happily calling Gmail. The app
    // picker filters its whole catalogue on these two flags, so every Google
    // and Microsoft entry dropped out; with nothing left the picker hid itself
    // entirely and the user lost the control with no error to explain it.
    // Hydrating here keeps the two surfaces telling the same story.
    if (!req.session.oauthProvider && userId) {
        try {
            const { hydrateGoogleSessionFromVault } = require('../../../auth/googleSessionHydration');
            await hydrateGoogleSessionFromVault(req.session);
        } catch (_) { /* non-fatal — the flags just stay false */ }
    }
    if (!req.session.oauthProvider && userId) {
        try {
            const { hydrateMicrosoftSessionFromVault } = require('../../../auth/microsoftSessionHydration');
            await hydrateMicrosoftSessionFromVault(req.session);
        } catch (_) { /* non-fatal — the flags just stay false */ }
    }

    const isGoogleUser = req.session.oauthProvider === 'google';
    const isMicrosoftUser = req.session.oauthProvider === 'microsoft';
    // A Microsoft 365 vault connection NEXT TO another SSO identity (Google,
    // Nextcloud): the session stays the other provider's, but
    // getIntegrationTools lifts the Outlook tools off this credential, so the
    // app picker must offer Outlook too (agent-hub integrationAvailability).
    let hasMicrosoftConnection = isMicrosoftUser;
    if (!hasMicrosoftConnection && userId) {
        try {
            const routineCredentialStore = require('../../../stores/routineCredentialStore');
            const rows = await routineCredentialStore.listProvidersForUser(userId);
            hasMicrosoftConnection = rows.some(r => r.provider === 'microsoft' && r.status === 'active');
        } catch (_) { /* non-fatal — Outlook just stays SSO-gated */ }
    }
    const enabledApps = await configStore.getConfig(`enabled_apps_user_${userId}`);

    // Load org-level enabled integrations.
    //
    // Via core/enabledIntegrations, NOT by reading a column here. An org's live
    // grants — everything the Integrations admin screen toggles — live in
    // `org_enabled_integrations`; the camelCase `enabledIntegrations` column is
    // only populated for orgs a super-admin explicitly overrode. This handler
    // used to read the legacy column alone, so an org carrying a stale override
    // (say, a nextcloud-only list from an earlier migration) reported that list
    // as the whole allow-list. The composer's app picker filters its entire
    // catalogue through this value and hides itself when nothing survives — so
    // every Google and Microsoft app silently disappeared from the picker while
    // the model, which resolves grants properly, went on calling Gmail happily.
    // resolveOrgIntegrations unions both columns and falls back to the
    // deployment default, and returns null for "no restriction" rather than an
    // empty list, which the client reads as "allow nothing".
    // One org read for the whole handler: this used to be three separate
    // userStore.getUser() calls plus a fourth inside the org-id helper, each
    // free to disagree with the next.
    const { orgId: n8nOrgId, homeOrgId } = await orgScope(req);

    let orgEnabledIntegrations = null;
    try {
        if (homeOrgId) {
            const { resolveOrgIntegrations } = require('../../../core/integrations/enabledIntegrations');
            orgEnabledIntegrations = await resolveOrgIntegrations(homeOrgId);
        }
    } catch (e) { /* ignore — null means "no org restriction" */ }

    // Check n8n config for org (uses group-based fallback for super-admins)
    let hasN8nConfig = false;
    try {
        if (n8nOrgId) {
            const n8nUrl = await configStore.getConfig(`n8n_url_org_${n8nOrgId}`);
            const n8nKey = await configStore.getSecret(`n8n_api_key_org_${n8nOrgId}`);
            hasN8nConfig = !!(n8nUrl && n8nKey);
        }
    } catch (e) { /* ignore */ }

    // Check org privacy shield for disableSearchOnUpload + EU mode
    let disableSearchOnUpload = false;
    let orgEuModeForced = false;
    let userOrgId = null;
    try {
        if (homeOrgId) {
            userOrgId = homeOrgId;
            const shield = await configStore.getConfig(`org_privacy_shield_${userOrgId}`);
            if (shield?.enabled && shield.disableSearchOnUpload) {
                disableSearchOnUpload = true;
            }
            if (shield?.enabled && shield.euModeEnabled) {
                orgEuModeForced = true;
            }
        }
    } catch (e) { /* ignore */ }

    // Personal EU mode preference — the Privacy Shield panel
    // (user_privacy_shield_${userId}) is the canonical store. We still
    // honour the legacy `user_eu_mode_${userId}` key as a fallback for
    // users who toggled the old (now-removed) Startup Agent EU switch
    // before this panel existed; isEUModeActive does the same.
    const userShield = await configStore.getConfig(`user_privacy_shield_${userId}`);
    const userEuModeEnabled = !!(userShield?.enabled && userShield?.euModeEnabled)
        || !!(await configStore.getConfig(`user_eu_mode_${userId}`));

    // Personal Simple Mode preference — strips the UI down to chat + agents
    const simpleMode = !!(await configStore.getConfig(`simple_mode_user_${userId}`));

    // Memory master switch — the per-user "may this turn read/write memory"
    // decision. Defaults ON, so this is only ever false after an explicit choice.
    const memoryEnabled = await isMemoryEnabledForUser(userId);

    // Has the user seen the new-user product tour? Stored per-user in the DB so
    // it persists across devices (the OnboardingTour also keeps a localStorage
    // flash-guard, but this is the authoritative source).
    const hasSeenIntroTour = !!(await configStore.getConfig(`has_seen_intro_tour_user_${userId}`));

    // Per-lesson Learning Center completion: { [lessonId]: { completedAt } }.
    // Stored per-user in the DB so checkmarks persist across devices (the client
    // also keeps a localStorage mirror as a flash-guard). Read through
    // readServerProgress so the legacy intro-tour flag is lazily migrated into a
    // real getting-started entry (same view the achievements endpoints use).
    let learningProgress = {};
    try { learningProgress = await readServerProgress(userId); } catch (_) { /* empty on failure */ }

    // Learning path (v2): the role/goal the learner picked on the Learning
    // Center home ('everyday' | 'builder' | 'admin' | 'skipped'). A preference,
    // not progress — stored beside the blob, never inside it (the progress
    // sanitizer whitelists lesson ids and would drop it).
    let learningPath = '';
    try { learningPath = (await configStore.getConfig(`learning_path_user_${userId}`)) || ''; } catch (_) { /* optional */ }

    // Check if EU models are configured at all (admin must set these up)
    let hasEuModelsConfigured = false;
    try {
        const euTiers = await configStore.getConfig('chat_model_tiers_eu') || {};
        hasEuModelsConfigured = Object.values(euTiers).some(t => t?.modelId?.trim());
    } catch (_) {}

    res.json({
        hasFirefliesKey: !!(await configStore.getSecret(`fireflies_api_key_user_${userId}`)),
        hasYouTrackConfig: !!(await configStore.getSecret(`youtrack_url_user_${userId}`)) && !!(await configStore.getSecret(`youtrack_token_user_${userId}`)),
        hasSignRequestConfig: !!(await configStore.getSecret(`signrequest_subdomain_user_${userId}`)) && !!(await configStore.getSecret(`signrequest_token_user_${userId}`)),
        hasGammaKey: !!(await configStore.getSecret(`gamma_api_key_user_${userId}`)),
        hasAfasConfig: !!(await configStore.getSecret(`afas_token_user_${userId}`)) && !!(await configStore.getSecret(`afas_member_number_user_${userId}`)),
        hasNmbrsConfig: !!(await configStore.getSecret(`nmbrs_subdomain_user_${userId}`)) && !!(await configStore.getSecret(`nmbrs_token_user_${userId}`)),
        hasVplanConfig: !!(await configStore.getSecret(`vplan_api_key_user_${userId}`)) && !!(await configStore.getSecret(`vplan_api_env_user_${userId}`)),
        // Non-secret NMBRS fields so the settings form can pre-fill (the token is never returned).
        nmbrsApiMode: (await configStore.getSecret(`nmbrs_api_mode_user_${userId}`)) || 'soap',
        nmbrsSubdomain: (await configStore.getSecret(`nmbrs_subdomain_user_${userId}`)) || '',
        nmbrsEmail: (await configStore.getSecret(`nmbrs_email_user_${userId}`)) || '',
        nmbrsEnv: (await configStore.getSecret(`nmbrs_env_user_${userId}`)) || 'production',
        hasLinkedInConfig: !!(await configStore.getSecret('linkedin_client_id')) && !!(await configStore.getSecret('linkedin_client_secret')),
        hasWithingsConfig: !!(await configStore.getSecret('withings_client_id')) && !!(await configStore.getSecret('withings_client_secret')),
        hasGoogleKey: !!(await configStore.getSecret('google_api_key')),
        hasElevenLabsKey: !!(await configStore.getSecret('elevenlabs_api_key')),
        isGoogleUser,
        isMicrosoftUser,
        hasMicrosoftConnection,
        enabledApps: enabledApps || null,
        orgEnabledIntegrations,
        hasN8nConfig,
        hasGoogleMapsKey: !!(await configStore.getSecret('google_maps_api_key')),
        disableSearchOnUpload,
        searchProvider: await configStore.getConfig('search_provider') || 'agent-search',
        // EU model preference
        userEuModeEnabled,
        orgEuModeForced,
        hasEuModelsConfigured,
        // Simple Mode (personal UI preference)
        simpleMode,
        // Memory master switch (personal; core/memory/memoryPolicy.js)
        memoryEnabled,
        // New-user product tour seen flag (personal UI preference)
        hasSeenIntroTour,
        // Learning Center per-lesson completion map
        // Learning Center per-lesson completion map
        learningProgress,
        // Learning Center path choice ('' = never asked)
        learningPath,
    });
});

router.post('/user-settings', requireAuth, validate({ body: UserSettingsBody }), async (req, res) => {
    const userId = req.session.user.id;
    const { enabledApps, simpleMode, memoryEnabled, hasSeenIntroTour, learningProgress, learningProgressReset, learningPath } = req.body;

    // The last refusal, and it too runs before anything is written: the
    // Learning Center blob is size-checked by its own sanitizer.
    let learning = null;
    if (learningProgressReset !== true && learningProgress) {
        learning = sanitizeLearningProgress(learningProgress);
        if (learning.error === 'too_large') {
            return res.status(400).json({ error: 'Learning progress payload too large.' });
        }
    }

    // Integration credentials, each already shape-checked by the schema.
    // Empty string (or null) clears a field — disconnect.
    const SECRETS = {
        firefliesApiKey: 'fireflies_api_key',
        gammaApiKey: 'gamma_api_key',
        youtrackUrl: 'youtrack_url',
        youtrackToken: 'youtrack_token',
        signrequestSubdomain: 'signrequest_subdomain',
        signrequestToken: 'signrequest_token',
        afasMemberNumber: 'afas_member_number',
        afasToken: 'afas_token',
        afasEnvType: 'afas_env_type',
        nmbrsApiMode: 'nmbrs_api_mode',
        nmbrsSubdomain: 'nmbrs_subdomain',
        nmbrsEmail: 'nmbrs_email',
        nmbrsToken: 'nmbrs_token',
        nmbrsEnv: 'nmbrs_env',
        vplanApiKey: 'vplan_api_key',
        vplanApiEnv: 'vplan_api_env',
    };
    for (const [field, key] of Object.entries(SECRETS)) {
        if (req.body[field] !== undefined) {
            await configStore.setSecret(`${key}_user_${userId}`, req.body[field] || '');
        }
    }

    if (enabledApps !== undefined) {
        await configStore.setConfig(`enabled_apps_user_${userId}`, enabledApps);
    }

    // EU mode is now managed exclusively through the Privacy Shield panel
    // (`user_privacy_shield_${userId}.euModeEnabled`). The legacy
    // `userEuModeEnabled` write here used to power the Startup-Agent toggle;
    // that toggle was removed because it bypassed the master Privacy Shield
    // switch and split the source of truth. Accepting writes here would let
    // a stale client silently change EU routing — the schema refuses them.

    if (simpleMode !== undefined) {
        await configStore.setConfig(`simple_mode_user_${userId}`, simpleMode);
    }

    // Memory master switch. Stored as a boolean and read back as `!== false`
    // (memoryPolicy.isMemoryEnabledForUser): memory defaults ON, so only an
    // explicit `false` turns it off. The schema guarantees a real boolean —
    // the text "false" used to be stored here as true.
    if (memoryEnabled !== undefined) {
        await configStore.setConfig(memoryEnabledKey(userId), memoryEnabled);
    }

    if (hasSeenIntroTour !== undefined) {
        await configStore.setConfig(`has_seen_intro_tour_user_${userId}`, hasSeenIntroTour);
    }

    // Learning Center completion map. This blob feeds badge/certificate
    // eligibility, so incoming payloads are sanitized (lesson ids whitelisted
    // against the server catalog, entries shape-checked, size-capped) and MERGED
    // into the stored map — a stale device can no longer erase another device's
    // progress. Reset is an explicit flag, since under merge semantics an empty
    // map would be a no-op.
    if (learningProgressReset === true) {
        await configStore.setConfig(`learning_progress_user_${userId}`, {});
        // Mark the legacy intro-tour migration done so the old flag can't
        // resurrect 'getting-started' after an explicit reset.
        await configStore.setConfig(`learning_intro_migrated_user_${userId}`, true);
    } else if (learning) {
        const { map, dropped } = learning;
        if (dropped.length) log.warn(`[user-settings] dropped ${dropped.length} invalid learning progress entries for user ${userId}`);
        if (map && Object.keys(map).length) {
            const existing = (await configStore.getConfig(`learning_progress_user_${userId}`)) || {};
            await configStore.setConfig(
                `learning_progress_user_${userId}`,
                mergeLearningProgress(existing, map),
            );
        }
    }

    // Learning path (v2) — the schema admits only a known choice ('' clears
    // it; 'skipped' stops the picker re-prompting).
    if (learningPath !== undefined) {
        await configStore.setConfig(`learning_path_user_${userId}`, learningPath);
    }

    res.json({ success: true });
});

module.exports = router;
