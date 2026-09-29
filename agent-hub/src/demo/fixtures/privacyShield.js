/**
 * Fixtures for the Privacy Shield demo.
 *
 * Targets `components/admin/guardrails/orgShield/OrgShieldEditor` — the
 * organisation shield at /app/settings/organisation/privacy, all six tabs:
 * Overview, What we look for, Your own data, What happens, Leaving your org,
 * What happened. "Your own data" lives in privacyShieldOwnData.ts.
 *
 * WHAT THIS REPLACED, AND WHY
 * The demo used to be a composite: the CONSUMER privacy panel
 * (pages/settings/ConsumerPrivacySection — "for your account") beside a chat
 * you could type into. It read well, but it was not the screen. An
 * administrator evaluating whether this product can hold their organisation's
 * data goes looking for the organisation shield, and the demo showed them a
 * personal preferences pane with a different title, a different scope and a
 * different set of controls. A demo of the wrong screen is worse than none:
 * it is a confident answer to a question nobody asked.
 *
 * THE ORGANISATION IS THE SAME ONE AS THE COMPLIANCE DEMO: Van Dael
 * Assurantiën, the fictional Dutch insurance intermediary from
 * fixtures/compliance.js. Somebody who opens both demos should find one
 * company, not two. The "What happened" evidence (thirty days of shield
 * events and tool traffic, with the world map's locations) lives in
 * privacyShieldActivity.ts.
 *
 * THE CONFIGURATION AND THE ACTIVITY TELL ONE STORY. "EU-hosted AI only" is
 * OFF, and the "What happened" tab then reports, from its own numbers, that
 * personal data reached servers outside Europe. That is deliberate: the
 * evidence tab exists to show an administrator something they did not know,
 * and the switch that fixes it is two tabs away. A demo configured perfectly
 * has nothing to demonstrate.
 *
 * SHAPES COME FROM THE SERVER, NOT FROM GUESSWORK:
 *   - the shield document mirrors the default in server/routes/orgPrivacyShield.js
 *     and must survive `normaliseDoc` in useOrgShield.js — note that
 *     `applyToAutomations` and `piiAllowPublicOrgs` are read as `!== false`,
 *     so absent means ON, and that `piiDetectionCategories` is filtered
 *     against the 21 ids in config/piiCategories.ts (a typo does not error,
 *     it silently disappears);
 *   - the two /overview responses mirror `getGuardrailOverview`
 *     (server/stores/guardrailEventStore.js) and `getIntegrationOverview`
 *     (server/stores/integrationActivityStore.js). `by_surface` is in the
 *     former and NOT in the hook's EMPTY_GUARD, so omitting it would render
 *     an empty card rather than an error.
 *
 * A non-OK GET on the shield document does not render an empty form — it
 * renders a red error box and no form at all (OrgShieldEditor). Every route
 * the editor touches has to answer.
 */

import { COMMON_ROUTES, daysAgo } from './common';
import {
    DESTINATIONS, EGRESS_ROWS, GUARD_OVERVIEW, GUARD_ROWS, INTEG_OVERVIEW, NON_EU_CALLS, PII_NON_EU,
    SOVEREIGNTY_SCORE, TOTAL_CALLS, TOTAL_EVENTS, TOTAL_PII,
} from './privacyShieldActivity';
import {
    LEGACY_ID, OWN_DATA_ROUTES, POLIS_ID, PROJECT_ID, ownDataTests, ownDataTypes,
} from './privacyShieldOwnData';

const ORG = 'org_demo_vandael';
const ORG_NAME = 'Van Dael Assurantiën B.V.';

/* ── The shield document ────────────────────────────────────────────────
   An insurance intermediary: it handles names, addresses, bank details, BSN
   and — because it writes disability and health claims — medical data. The
   selection below is what that organisation would actually switch on, and
   the Overview's "N of 21" row counts it literally. */

const WATCHED_CATEGORIES = [
    'Person', 'DateOfBirth', 'PhoneNumber', 'Email', 'Address',
    'InternationalBankingAccountNumber', 'NationalIdentificationNumber',
    'HealthInsuranceNumber', 'MedicalCondition',
];

export function shieldDoc() {
    return {
        organization_id: ORG,
        enabled: true,
        collectionIds: [],
        scope: { userInput: true, agentOutput: true },
        action: 'delete',

        // OFF on purpose — see the header. The activity tab reports the
        // consequence, and this is the switch that ends it.
        euModeEnabled: false,

        // The org's own types are switched on the same way as the built-in
        // kinds: by their id in these lists (see privacyShieldOwnData.ts).
        piiDetectionCategories: [...WATCHED_CATEGORIES, POLIS_ID, PROJECT_ID, LEGACY_ID],
        // Not one of the presets, so the Overview row reads "Custom (65%)"
        // rather than a preset name — the shape a real tuned install is in.
        piiDetectionConfidenceThreshold: 0.65,
        // Tokenise and restore: the answer that keeps the reply readable.
        // Requires the pii_tokenize capability, which fixtures/common.js
        // grants — without it this renders as a licence lock.
        piiDetectionAction: 'tokenize',
        piiFailureMode: 'fail_closed',
        attachmentLargeInputPolicy: 'fail_open',
        showRawPayload: true,

        dlpEnabled: true,
        dlpMode: 'ask',
        webSearchGuardEnabled: true,
        webSearchGuardPiiCategories: ['NationalIdentificationNumber', 'HealthInsuranceNumber', 'MedicalCondition'],
        disableSearchOnUpload: true,

        toolPiiPolicy: {
            external: {
                blockCategories: [
                    'NationalIdentificationNumber', 'HealthInsuranceNumber',
                    'MedicalCondition', 'InternationalBankingAccountNumber',
                    POLIS_ID, PROJECT_ID,
                ],
            },
            internal: { blockCategories: ['NationalIdentificationNumber'] },
        },

        monitorIntegrations: true,
        applyToAutomations: true,

        // "Your own data": a fixed format, an AI type and one term migrated
        // from the old "Always hide these" list. The server keeps
        // `customSensitiveTerms` as a mirror of the words and patterns.
        customDataTypes: ownDataTypes(daysAgo(9)),
        customDataTests: ownDataTests(daysAgo(9)),
        customSensitiveTerms: ['schadedossier'],
        // The names that would otherwise be reported as people on every single
        // message. `piiAllowPublicOrgs` covers the well-known companies.
        piiAllowTerms: ['Van Dael', 'Kifid', 'Zorgverzekeraars Nederland'],
        piiAllowPublicOrgs: true,

        updatedAt: daysAgo(9),
        updatedBy: 'Marieke de Wit',
    };
}

/* ── State + routes ─────────────────────────────────────────────────── */

export function createState() {
    return { shield: shieldDoc() };
}

export const ROUTES = {
    ...COMMON_ROUTES,

    /**
     * Is the PII Guard installed and answering?
     *
     * Declared BEFORE `:orgId` — `/user/guard-status` would otherwise be read
     * as an organisation called "user" and answer with the shield document.
     *
     * Answers HEALTHY, and that is a deliberate departure from the round-2
     * artboards, which show "Detection service not responding" to demonstrate
     * the honest-degradation state. In a fixture that anyone can open without
     * logging in, a red "our scanner is down" pill does not read as "look how
     * candid this product is" — it reads as "this product is broken". The
     * fixture's job is to show an organisation that is MISCONFIGURED (EU-only
     * off, personal data reaching Toronto) on a platform that is working. The
     * guard-down state is covered by the editor's own tests instead.
     */
    'GET /api/org-privacy-shield/user/guard-status': () => ({ configured: true, reachable: true }),

    'GET /api/org-privacy-shield/:orgId': ({ state }) => state.shield,

    // The "Your own data" test bench, answered in the browser.
    ...OWN_DATA_ROUTES,

    /**
     * Saving really saves — for this tab. The editor overlays its fields onto
     * the document it loaded and PUTs the whole thing, so writing the body
     * straight back is what the server does too. `clamped_fields` and
     * `termErrors` are empty because the demo grants the capabilities the
     * document uses; returning them absent would render as "saved with notes".
     */
    'PUT /api/org-privacy-shield/:orgId': ({ state, body }) => {
        state.shield = {
            ...state.shield,
            ...(body || {}),
            organization_id: ORG,
            updatedAt: new Date().toISOString(),
            updatedBy: 'Demo user',
        };
        return { config: state.shield, clamped_fields: [], termErrors: [], typeErrors: [] };
    },

    /**
     * These two decide whether two Overview rows exist at all. `searchProvider`
     * set → "Web search protection"; a non-empty EU model map → "EU-hosted AI
     * only". Both are on the screenshot the page is selling, and both vanish
     * silently if these return empty.
     */
    'GET /ai/config': () => ({
        searchProvider: 'searxng',
        piiDetectionCategories: WATCHED_CATEGORIES,
    }),
    'GET /ai/config/chat-models-eu': () => ({
        fast: { modelId: 'mistral-small-latest' },
        balanced: { modelId: 'azure/gpt-4.1-swedencentral' },
        powerful: { modelId: 'mistral-large-latest' },
    }),

    // Fetched even with the org pinned. The picker is not rendered, but the
    // transport fails closed, so an unanswered route is a console warning and
    // a failed test rather than nothing.
    'GET /auth/organizations': () => ([{ id: ORG, name: ORG_NAME }]),

    // ── "What happened" ───────────────────────────────────────────────
    'GET /api/usage/guardrails/overview': () => GUARD_OVERVIEW(),
    'GET /api/usage/integrations/overview': () => INTEG_OVERVIEW(),
    // `query` is a URLSearchParams, not a plain object — `query.eu` reads
    // undefined and every filter below would silently pass everything, which
    // shows as a drill labelled "Outside Europe" listing EU rows.
    'GET /api/usage/guardrails/recent': ({ query }) => {
        const user = query.get('user');
        const rows = GUARD_ROWS().filter(r => !user || r.user_id === user);
        return rows.slice(0, Number(query.get('limit')) || 50);
    },
    'GET /api/usage/integrations/egress': ({ query }) => {
        const [eu, user, integration] = ['eu', 'user', 'integration'].map(k => query.get(k));
        const rows = EGRESS_ROWS().filter(r =>
            (eu !== 'false' || !r.is_eu)
            && (!user || r.user_id === user)
            && (!integration || r.integration_type === integration));
        return rows.slice(0, Number(query.get('limit')) || 50);
    },
};

// Exported for the tests: they assert the arithmetic a visitor can check by
// reading the screen, not just that the keys exist.
export const _internals = {
    GUARD_OVERVIEW, INTEG_OVERVIEW, GUARD_ROWS, EGRESS_ROWS,
    DESTINATIONS, WATCHED_CATEGORIES,
    TOTAL_EVENTS, TOTAL_PII, TOTAL_CALLS, NON_EU_CALLS, PII_NON_EU, SOVEREIGNTY_SCORE,
};
