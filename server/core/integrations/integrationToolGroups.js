/**
 * The credential-gated tool groups of getIntegrationTools
 * (./integrationTools.js): the OAuth providers (Google, Microsoft), the
 * install-wide API keys (image/video generation, ElevenLabs, web search,
 * the browser), and the per-user credentials (Fireflies … GitHub, the
 * Mistral-backed transcription), with connection lending where a provider
 * allows it.
 *
 * Every function takes the run context `c` built in getIntegrationTools:
 * `{ userId, session, userSimpleMode, isAppOn, addTools, isLentProvider, T, D }`.
 * The toolsets (`c.T`, e.g. `T.GMAIL_TOOLS`) and every collaborator in the
 * server's large import cycle (`c.D`: the config store and lazy getters for
 * the rest) are handed in by ./integrationTools, which requires them, so this
 * module stays out of that cycle.
 * The ORDER of the calls is the order the model sees the tools in, and the
 * order of the configStore lookups is pinned by
 * integrationTools.characterisation.test.js.
 */

const log = require('../../telemetry/log');

/**
 * BFSF-255: password-account users acquire Google tokens via the Settings →
 * Connections tile (encrypted vault), not via SSO login — so a session
 * without ANY OAuth identity gets hydrated from the vault before the
 * provider checks. Sessions that already carry a provider (Google/Microsoft/
 * Nextcloud SSO) are never touched: the dispatcher hands ONE session to the
 * executors and mixing providers would run Gmail calls with a foreign token.
 * The same now applies to Microsoft: a user who connects Outlook through
 * Settings → Connections has a vault credential but no SSO session. Google
 * is tried first purely to preserve the pre-existing precedence for users
 * who somehow hold both; each helper is a no-op once a provider is set.
 */
async function hydrateSessionFromVault({ session, D }) {
    if (!session?.oauthProvider && session?.user?.id) {
        try {
            const { hydrateGoogleSessionFromVault } = D.googleSessionHydration();
            await hydrateGoogleSessionFromVault(session);
        } catch (_) { /* non-fatal — tools just stay unavailable */ }
    }
    if (!session?.oauthProvider && session?.user?.id) {
        try {
            const { hydrateMicrosoftSessionFromVault } = D.microsoftSessionHydration();
            await hydrateMicrosoftSessionFromVault(session);
        } catch (_) { /* non-fatal — tools just stay unavailable */ }
    }
}

/** Google and Microsoft — require OAuth. */
async function addOAuthProviderTools({ userId, session, isAppOn, addTools, T, D }) {
    if (session?.oauthProvider === 'google' && session?.accessToken) {
        if (isAppOn('gmail')) addTools(T.GMAIL_TOOLS);
        if (isAppOn('google-calendar')) addTools(T.CALENDAR_TOOLS);
        if (isAppOn('google-drive')) addTools(T.DRIVE_TOOLS);
        if (isAppOn('google-docs')) addTools(T.DOCS_TOOLS);
        if (isAppOn('google-sheets')) addTools(T.SHEETS_TOOLS);
        if (isAppOn('google-slides')) addTools(T.SLIDES_TOOLS);
        if (isAppOn('google-contacts')) addTools(T.CONTACTS_TOOLS);
        if (isAppOn('google-keep')) addTools(T.KEEP_TOOLS);
        if (isAppOn('google-groups')) addTools(T.GOOGLE_GROUPS_TOOLS);
    }

    if (session?.oauthProvider === 'microsoft' && session?.accessToken) {
        if (isAppOn('outlook')) addTools(T.OUTLOOK_TOOLS);
        if (isAppOn('outlook-readonly')) addTools(T.OUTLOOK_READONLY_TOOLS);
        if (isAppOn('ms-calendar')) addTools(T.MS_CALENDAR_TOOLS);
        if (isAppOn('onedrive')) addTools(T.ONEDRIVE_TOOLS);
        if (isAppOn('ms-contacts')) addTools(T.MS_CONTACTS_TOOLS);
    } else if (userId && (isAppOn('outlook') || isAppOn('outlook-readonly'))) {
        // Multi-provider: a Google (or Nextcloud) session whose user ALSO
        // connected Microsoft 365 through Settings → Connections — or a
        // automation session whose primary provider is not Microsoft but which
        // carries `automationProviders.microsoft`. The session itself stays as it
        // is (the Google tools above need its token); the Outlook tools get a
        // Microsoft-only shim at dispatch (toolDispatcher). Only Outlook is
        // lifted here: its approval routes resolve the same shim, the other
        // Microsoft apps still read the live session.
        let msSession = null;
        try {
            const { resolveMicrosoftSession } = D.microsoftSessionHydration();
            msSession = await resolveMicrosoftSession(session, userId);
        } catch (_) { /* non-fatal — Outlook just stays unavailable */ }
        if (msSession?.accessToken) {
            if (isAppOn('outlook')) addTools(T.OUTLOOK_TOOLS);
            if (isAppOn('outlook-readonly')) addTools(T.OUTLOOK_READONLY_TOOLS);
        }
    }
}

/** Image/video generation, ElevenLabs, web search and the browser — install-wide keys and backends. */
async function addKeyedServiceTools({ isAppOn, addTools, T, D }) {
    // Image Generation — requires Google API key
    const hasGoogleKey = !!(await D.configStore.getSecret('google_api_key'));
    if (hasGoogleKey && isAppOn('image-gen')) {
        addTools(T.IMAGE_GEN_TOOLS);
    }

    // Video Generation — requires Google API key (Veo 3.1)
    if (hasGoogleKey && isAppOn('video-gen')) {
        addTools(T.VIDEO_GEN_TOOLS);
    }

    // ElevenLabs — Music (with vocals), TTS, Sound Effects
    const hasElevenLabsKey = !!(await D.configStore.getSecret('elevenlabs_api_key'));
    if (hasElevenLabsKey && isAppOn('elevenlabs')) {
        addTools(T.ELEVENLABS_TOOLS);
    }

    await addWebSearchTools({ isAppOn, addTools, T, D });

    // Browse Web — interactive headless browser (drive/read JS-rendered pages)
    // for content agent_search's plain fetch can't render. Cheap operational
    // probe only (dockerAvailable()/BROWSER_WS_ENDPOINT) — never spins up the
    // bf-browser container here, that happens lazily on first actual tool call.
    if (isAppOn('browser-fetch')) {
        let hasBrowserBackend = false;
        try {
            const pwtRunner = D.pwtRunner();
            hasBrowserBackend = !!process.env.BROWSER_WS_ENDPOINT || await pwtRunner.dockerAvailable();
        } catch (_) { hasBrowserBackend = false; }
        if (hasBrowserBackend) {
            addTools(T.BROWSE_WEB_TOOLS);
        } else {
            log.warn('[IntegrationTools] browse_web NOT registered: no browser backend available (Docker unreachable and BROWSER_WS_ENDPOINT unset).');
        }
    }
}

/**
 * Agent Search — self-hosted AI search, Bing, or cloud-only node-search.
 * Shared with the Automation Builder's chat (webSearchAvailability.js), so
 * both offer web search on exactly the same installations. It includes the
 * node-search fallback for an agent-search provider without its GPU URL.
 */
async function addWebSearchTools({ isAppOn, addTools, T, D }) {
    const { available: searchAvailable, provider: searchProvider, fallbackToNode: canFallbackToNode } =
        await D.webSearchAvailability().webSearchProviderStatus({ configStore: D.configStore, env: process.env });
    if (searchAvailable && isAppOn('agent-search')) {
        // AGENT_SEARCH_TOOLS carries agent_search AND read_url (see agentSearchTools.js):
        // read_url is offered exactly where web search is.
        addTools(T.AGENT_SEARCH_TOOLS);
        if (canFallbackToNode) {
            log.warn('[IntegrationTools] agent_search registered via node-search fallback: provider=agent-search but SEARCH_SERVICE_URL/agent_search_url is empty. Using serper_api_key directly. Set search_provider=node-search explicitly to silence this.');
        }
    } else if (isAppOn('agent-search') && searchProvider !== 'disabled') {
        if (searchProvider === 'agent-search') {
            log.warn('[IntegrationTools] agent_search NOT registered: provider=agent-search but SEARCH_SERVICE_URL is not set, no agent_search_url admin config, and no serper_api_key for node-search fallback. The model will not have web search. Set SEARCH_SERVICE_URL, or set serper_api_key + search_provider=node-search.');
        } else if (searchProvider === 'bing') {
            log.warn('[IntegrationTools] agent_search NOT registered: provider=bing but bing_search_key secret is not set. The model will not have web search.');
        } else if (searchProvider === 'node-search') {
            log.warn('[IntegrationTools] agent_search NOT registered: provider=node-search but serper_api_key secret is not set. The model will not have web search.');
        }
    }
}

/**
 * Connection lending (gated). On a SHARED resource run (connectionPolicy
 * carries the owner + resource), a provider the running user hasn't
 * connected may still be available via a LENT connection from the owner
 * (full delegation, resolved at dispatch). The returned check lets the
 * catalog OFFER those tools; the dispatch override in chatStream/
 * chatWithAgent then runs them as the owner. Inert unless
 * INTEGRATION_CONNECTION_LENDING_ENABLED is set AND a policy is passed — and
 * only agent paths that ALSO apply the dispatch override pass a policy.
 */
function makeLentProviderCheck({ userId, connectionPolicy, D }) {
    let _lendCtx = undefined;
    const _cr = D.connectionResolution();
    const _lendingOn = _cr.isLendingEnabled() && connectionPolicy && connectionPolicy.ownerUserId && connectionPolicy.ownerUserId !== userId;
    return async function isLentProvider(provider) {
        if (!_lendingOn) return false;
        try {
            if (_lendCtx === undefined) _lendCtx = await _cr.runningUserContext(userId);
            const store = D.integrationConnectionStore();
            const r = await store.resolveConnectionForRun({
                runningUserId: userId, runningUserOrgId: _lendCtx.orgId, runningUserGroups: _lendCtx.groups,
                ownerUserId: connectionPolicy.ownerUserId, provider,
                resourceType: connectionPolicy.resourceType || null, resourceId: connectionPolicy.resourceId || null,
            });
            return !!(r && r.mode === 'delegated');
        } catch (_) { return false; }
    };
}

/** Business apps keyed on the user's own credentials (Fireflies … Scaleway Billing). */
async function addUserCredentialTools({ userId, userSimpleMode, isAppOn, addTools, isLentProvider, T, D }) {
    // Fireflies — requires user API key (or a lent connection)
    const hasFirefliesKey = !!(await D.configStore.getSecret(`fireflies_api_key_user_${userId}`)) || await isLentProvider('fireflies');
    if (!userSimpleMode && hasFirefliesKey && isAppOn('fireflies')) {
        addTools(T.FIREFLIES_TOOLS);
    }

    // YouTrack — requires user URL + token (or a lent connection)
    const hasYouTrackConfig = (!!(await D.configStore.getSecret(`youtrack_url_user_${userId}`)) && !!(await D.configStore.getSecret(`youtrack_token_user_${userId}`))) || await isLentProvider('youtrack');
    if (hasYouTrackConfig && isAppOn('youtrack')) {
        addTools(T.YOUTRACK_TOOLS);
    }

    // Gamma — requires user API key (or a lent connection)
    const hasGammaKey = !!(await D.configStore.getSecret(`gamma_api_key_user_${userId}`)) || await isLentProvider('gamma');
    if (hasGammaKey && isAppOn('gamma')) {
        addTools(T.GAMMA_TOOLS);
    }

    // SignRequest — requires user subdomain + token (or a lent connection)
    const hasSignRequestConfig = (!!(await D.configStore.getSecret(`signrequest_subdomain_user_${userId}`)) && !!(await D.configStore.getSecret(`signrequest_token_user_${userId}`))) || await isLentProvider('signrequest');
    if (hasSignRequestConfig && isAppOn('signrequest')) {
        addTools(T.SIGNREQUEST_TOOLS);
    }

    // AFAS Profit — requires user member number + AppConnector token. Deliberately
    // NOT lendable (no isLentProvider clause): ERP data stays bring-your-own.
    const hasAfasConfig = !!(await D.configStore.getSecret(`afas_token_user_${userId}`)) && !!(await D.configStore.getSecret(`afas_member_number_user_${userId}`));
    if (hasAfasConfig && isAppOn('afas-profit')) {
        addTools(T.AFAS_TOOLS);
    }

    // NMBRS — read-only payroll/HR. Requires subdomain + token (and login email
    // for the SOAP API). Bring-your-own like AFAS: payroll data is not lendable.
    const hasNmbrsConfig = !!(await D.configStore.getSecret(`nmbrs_subdomain_user_${userId}`)) && !!(await D.configStore.getSecret(`nmbrs_token_user_${userId}`));
    if (hasNmbrsConfig && isAppOn('nmbrs')) {
        addTools(T.NMBRS_TOOLS);
    }

    // vPlan — read-only planning data. Requires the API key + environment pair.
    // Bring-your-own like AFAS/NMBRS (no isLentProvider clause): one vPlan API key
    // unlocks the whole environment, so lending it would over-share.
    const hasVplanConfig = !!(await D.configStore.getSecret(`vplan_api_key_user_${userId}`)) && !!(await D.configStore.getSecret(`vplan_api_env_user_${userId}`));
    if (hasVplanConfig && isAppOn('vplan')) {
        addTools(T.VPLAN_TOOLS);
    }

    // Scaleway Billing — read-only invoices. The secret key is required; the
    // organization id is optional. Bring-your-own (no isLentProvider clause):
    // a lent key would show one org's Scaleway bill to another.
    const hasScalewayBillingConfig = !!(await D.configStore.getSecret(`scaleway_billing_secret_key_user_${userId}`));
    if (hasScalewayBillingConfig && isAppOn('scaleway-billing')) {
        addTools(T.SCALEWAY_BILLING_TOOLS);
    }
}

/** LinkedIn, Withings, Google Maps and GitHub. */
async function addPersonalServiceTools({ userId, isAppOn, addTools, isLentProvider, T, D }) {
    // LinkedIn — requires user OAuth tokens (or a lent connection)
    const hasLinkedIn = !!(await D.configStore.getSecret(`linkedin_access_token_user_${userId}`)) || await isLentProvider('linkedin');
    if (hasLinkedIn && isAppOn('linkedin')) {
        addTools(T.LINKEDIN_TOOLS);
    }

    // Withings — requires an OAuth credential in the automation vault. Health data
    // is GDPR Article 9 special category, so it is deliberately NOT lendable:
    // no isLentProvider clause, and a teammate borrowing an owner's connection
    // must never inherit their body measurements.
    if (isAppOn('withings')) {
        const automationCredentialStore = D.automationCredentialStore();
        const withingsCred = await automationCredentialStore.getCredential(userId, 'withings').catch(() => null);
        if (withingsCred?.status === 'active') addTools(T.WITHINGS_TOOLS);
    }

    // Google Maps — requires Maps API key
    const hasMapsKey = !!(await D.configStore.getSecret('google_maps_api_key'));
    if (hasMapsKey && isAppOn('google-maps')) {
        addTools(T.MAPS_TOOLS);
    }

    // GitHub — requires user PAT (or a lent connection)
    const hasGitHub = !!(await D.configStore.getSecret(`github_token_user_${userId}`)) || await isLentProvider('github');
    if (hasGitHub && isAppOn('github')) {
        addTools(T.GITHUB_TOOLS);
    }
}

/** Transcription — requires an existing Mistral API key. */
async function addTranscriptionTools({ isAppOn, addTools, T, D }) {
    const hasMistralKey = !!(await D.configStore.getSecret('mistral_api_key'));
    if (hasMistralKey && isAppOn('transcription')) {
        addTools(T.TRANSCRIPTION_TOOLS);
    }
}

module.exports = {
    hydrateSessionFromVault, addOAuthProviderTools, addKeyedServiceTools, makeLentProviderCheck,
    addUserCredentialTools, addPersonalServiceTools, addTranscriptionTools,
};
