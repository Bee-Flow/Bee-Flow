// @typecheck strict
/**
 * Routes that are deliberately reachable without a chain gate, each with the
 * reason a reviewer can check. One list, two readers: auth/accessRegistry.sweep.test.js
 * (accountability: the route is accounted for) and routes.contract.test.js through
 * auth/routeContract.js (the class `open` and its reason). An entry with `bewijs`
 * (proof) is checked mechanically by the sweep test: the file exists and still
 * contains the marker.
 *
 * Keys: 'METHOD /path' (one route), 'file:<path>' (a whole file),
 * 'mount:/prefix' (a whole mount, dynamic ones too).
 */

'use strict';

/** @typedef {string | { reden: string, bewijs?: { file: string, marker: string } }} OpenReason */

/** @type {Map<string, OpenReason>} */
const OPEN_ROUTES = new Map(/** @type {Array<[string, OpenReason]>} */ ([
    // ── Health & API-naamkaartje ─────────────────────────────────────────
    ['GET /api/health', 'gezondheidsprobe — bewust anoniem, alleen status/buildstempel (index.js)'],
    ['GET /api', 'API-naamkaartje ({ name, status }) — geen data, geen sessie nodig'],
    ['GET /api/guard/health', 'statusprobe van de PII-guard-service, zelfde klasse als /api/health — meldt configured/available, geen gebruikersdata'],
    ['GET /api/health/schema', 'schema-gezondheidsprobe, per header "Ongeauthenticeerd, net als /api/health" (routes/healthSchema.js)'],
    ['file:routes/wellKnown.js', '/.well-known discovery-documenten (Azure publisher-domain, security.txt) — per definitie publiek'],

    // ── Anonieme telemetrie ──────────────────────────────────────────────
    ['POST /api/client-errors', 'anonieme client-fouttelemetrie mét rate limiter in de router — fouten vuren ook vóór/zonder sessie'],
    ['POST /api/web-vitals', {
        reden: 'Core Web Vitals-beacons; header zegt het zelf: TTFB/FCP vuren vóór de sessie bestaat. Sinds 2026-09-05 met dezelfde per-IP rate limiter als client-errors (60/min: één page load = tot vijf metric-beacons).',
        bewijs: { file: 'routes/webVitals.js', marker: 'beaconLimiter' },
    }],
    ['POST /api/csp-report', 'CSP-violation-reports van de browser — de browser stuurt ze zonder credentials; 32kb-limiet in de router'],

    // ── Marketing- en publiekssite ───────────────────────────────────────
    ['GET /api/public/github-stats', 'anoniem marketing-endpoint (github-stats-blok op de publieke site), zegt het al in zijn mountnaam'],
    ['GET /api/cms/site', 'gepubliceerde CMS-site-payload voor de marketingpagina — de rest van /api/cms zit achter router.use(\'/admin\'|\'/sites\', requireAdmin)'],
    ['GET /api/cms/<dynamisch>', 'de asset-regexroute (cms.js: router.get(/^\\/asset\\/(.+)$/)) — assets van gepubliceerde marketingpagina\'s'],
    ['file:routes/publicRender.js', 'server-rendered marketingpaginas, robots.txt, sitemap.xml, llms.txt — het bestaansrecht van dit bestand is anonieme crawlers (zie index.js, mount zonder pad)'],
    ['GET /api/billing/public-plans', 'publieke prijstabel voor de marketing-/signup-flow; de rest van /api/billing is requireAuth per route'],
    ['GET /api/release-notes/public', 'serveert alleen PUBLISHED entries; machinaal geschreven copy passeert eerst een mens via /admin/:id/publish (index.js-commentaar)'],
    ['GET /api/branding/public', 'publieke branding (naam/logo/kleuren) voor login- en marketingpagina — nodig vóór er een sessie is'],
    ['GET /api/branding/wallpaper/:filename', 'wallpaper-asset behorend bij de publieke branding hierboven'],
    ['GET /api/languages/public/locales', 'i18n: beschikbare talen voor login-/marketingpagina — vóór er een sessie is'],
    ['GET /api/languages/public/strings/:locale', 'i18n: vertaalstrings voor dezelfde pre-sessie-schermen'],
    ['GET /ai/model-costs', 'modelkostentabel; de header van routes/ai/config/modelCosts.js noemt hem expliciet "public read" — config/updates ernaast zijn requireAuth/admin'],

    // ── Webhooks & machine-authenticatie (credential zit in het verzoek) ─
    ['POST /api/stripe/webhook', {
        reden: 'Stripe-webhook — authenticatie is de Stripe-handtekening over de raw body (mount vóór bodyParser, index.js), geen sessie.',
        bewijs: { file: 'routes/stripe/webhook.js', marker: 'constructWebhookEvent' },
    }],
    ['mount:/api/mod', {
        reden: 'dynamische dispatcher voor remote modules — routers ontstaan bij module-activatie en zijn statisch onzichtbaar; het pakketkanaal is getekend/geverifieerd en dispatchRouter 404-verbergt inactieve modules.',
        bewijs: { file: 'modules/packageLoader.js', marker: 'dispatchRouter' },
    }],
    ['file:auth/connectorJwt.js', 'geen router maar app-brede middleware (pathless app.use in index.js) die connector-JWT\'s naar een sessie vertaalt — registreert zelf geen routes'],
    ['POST /api/automation/events/msgraph', 'MS Graph change-notification-webhook: het verplichte validationToken-handshake is per contract anoniem, en elke notificatie wordt tegen de per-subscription clientState gevalideerd (mismatch → drop) — routes/automation/events.js'],
    ['POST /api/automation/events/gmail', {
        reden: 'Gmail Pub/Sub-push; het SECURITY-commentaar ter plekke documenteert de staat: nog niet cryptografisch geauthenticeerd (OIDC-verificatie moet nog landen) maar fail-closed — userId is altijd null en dispatchEvent weigert null-userId gmail-events, dus floodbaar (rate-limited) maar niet triggerbaar. Herbeoordeel deze entry zodra OIDC + emailAddress→userId landen.',
        bewijs: { file: 'routes/automation/events.js', marker: 'NOT cryptographically authenticated' },
    }],

    // ── OAuth-callbacks: de identity provider is de authenticator ────────
    ['GET /api/integrations/google/callback', 'OAuth-callback — redirect van de IdP, noodzakelijk bereikbaar vóór er een sessie is; state/code-validatie in de handler'],
    ['GET /api/integrations/microsoft/callback', 'OAuth-callback, als google/callback'],
    ['GET /api/integrations/linkedin/callback', 'OAuth-callback, als google/callback'],
    ['GET /api/integrations/withings/callback', 'OAuth-callback, als google/callback'],

    // ── Zelf-gescoped op sessie-inhoud (geen gate nodig om te weigeren) ──
    ['GET /api/integrations/gmail/messages', {
        reden: 'leest uitsluitend via de OAuth-tokens ín de sessie (createGoogleApiClient(req.session)) — zonder sessie is het antwoord 401 NOT_CONNECTED; er is niets om van een ander te lezen.',
        bewijs: { file: 'routes/integrations/gmail.js', marker: 'createGoogleApiClient' },
    }],
    ['GET /api/integrations/gmail/messages/:messageId', 'als GET /api/integrations/gmail/messages — sessie-token-gescoped'],
    ['GET /api/integrations/gdrive/files', 'als gmail/messages: Drive-client komt uit req.session-tokens, anoniem → 401 NOT_CONNECTED (routes/integrations/googleDrive.js)'],
    ['GET /api/integrations/gdrive/export/:fileId', 'als GET /api/integrations/gdrive/files — sessie-token-gescoped'],
    ['GET /api/support/csat/:threadId/done', {
        reden: 'tokenloze bedankpagina na een CSAT-stem: vaste tekst uit het score-getal in de query, leest en schrijft geen thread. Bestaat zodat de stem-URL (mét token) na gebruik wordt vervangen door een URL zonder.',
        bewijs: { file: 'routes/support/satisfaction.js', marker: "'/csat/:threadId/done'" },
    }],
    ['GET /api/support/threads/mine', {
        reden: 'de eigen supporttickets van de ingelogde gebruiker. Geen keten-gate omdat /api/support ook anonieme marketing-intake draagt, maar de handler weigert zelf: geen userId → 401, en de query is gescoped op requesterUserId — er is niets van een ander te lezen. De handler-probe ziet dit patroon niet omdat getUserId(req) buiten haar werkwoordenlijst valt en er geen req.session in de body staat; dat is een gat in de PROBE, niet in de route.',
        bewijs: { file: 'routes/support/threads.js', marker: 'requesterUserId: userId' },
    }],

    // ── Token-als-credential: publiek gedeelde inhoud ────────────────────
    ['GET /api/public-app/:token', 'publieke intake van een Studio-app: het URL-token is de credential en ontsluit alleen de whitelist van schermen in de app-definitie (appStudio/publicAccess.js); bezoekers zijn per ontwerp anonieme derden'],
    ['GET /verify/:token', 'certificaatverificatie voor LinkedIn-shares — token-gated (alleen bewust publiek gezette certs resolven), per-IP rate limited (routes/verifyCertificate.js)'],
    ['GET /verify/:token/image.png', 'og:image bij GET /verify/:token — zelfde token-credential'],
    ['GET /verify/:token/certificate.pdf', 'PDF-download bij GET /verify/:token — zelfde token-credential'],
    ['GET /share/_brand/icon.svg', 'statisch brand-icoon op de publieke share-pagina\'s — de inhoudsroutes van /share zijn share-token-gated in routes/publicViewer.js'],
    ['GET /w/_brand/icon.svg', 'zelfde statische brand-icoon, tweede mount: routes/publicViewer.js hangt sinds W3 stap 4 óók op /w/<slug> (het adres van de pagina in plaats van dat van de share) — één router, één poort, dus dezelfde reden'],

    // ── GDPR: intake must be reachable (Art. 12) ──────────────────────────
    ['POST /api/dsr/requests', {
        reden: 'DSR-inname: een betrokkene zonder account moet een verzoek kunnen indienen (GDPR Art. 12); per-IP publicSubmitLimiter in de router, admin-kant zit achter requirePermission.',
        bewijs: { file: 'routes/dsr.js', marker: 'publicSubmitLimiter' },
    }],
    ['GET /api/dsr/requests/:id/public', 'status-URL uit de ontvangstbevestiging van POST /api/dsr/requests — het request-id is de (onraadbare) credential van de indiener'],
    // file:routes/support.js stond hier tot de parser de register-helper leerde
    // lezen. De reden van die blanket-entry was letterlijk "registreert zijn
    // routes via register*(router)-helpers in routes/support/* en is dus
    // statisch onzichtbaar" — precies de premisse die routeSurfaceSweep.js nu
    // weerlegt. De 42 routes achter /api/support worden sindsdien stuk voor
    // stuk gewogen: 41 dragen een gate-vormige check in hun handler
    // (admin_support-staf, eigenaarschap, of het anonieme toegangstoken van
    // POST /threads), en de ene die overbleef staat hieronder met naam en
    // reden. Eén blanket-vrijstelling minder, één precieze erbij.

    // ── Gast-chatoppervlak (bewust ontwerp: rijen gescoped op guest-id) ──
    ['GET /agents/:id/embed', 'publieke agent-embed met embedLimiter en 404-vervaging voor ongepubliceerde agents (routes/agents/chat.js:158)'],
    ['GET /agents/:id/history', 'gast-chat: history gescoped op getEffectiveUserId (guest-cookie-id voor anoniem) — je leest alleen je eigen gastgesprek'],
    ['DELETE /agents/:id/history', 'als GET /agents/:id/history — wist alleen het eigen (gast)gesprek'],
    ['file:routes/agents/conversations.js', {
        reden: 'gast-conversaties: elke store-call is gescoped op getEffectiveUserId; agent-leesbaarheid loopt waar relevant via canReadAgent (routes/agents/crud.js:158).',
        bewijs: { file: 'routes/agents/conversations.js', marker: 'getEffectiveUserId' },
    }],
    ['GET /agents/conversations/all', 'gast-conversatieoverzicht — zelfde getEffectiveUserId-scoping als routes/agents/conversations.js'],
    ['GET /agents', 'agentlijst gescoped op de effectieve gebruiker: gepubliceerde + eigen agents (routes/agents/crud.js:28); mutaties ernaast dragen requirePermission'],
    ['file:routes/agents/meta.js', 'component- en modelcatalogus voor de (gast)chat-UI — metadata, geen gebruikersdata'],
    // file:routes/memory.js stond hier van 2026-09-05 (dossier 4a) tot de
    // memory-overhaul: bewust gastpad, omdat de gastchat-runtime memories
    // onder het gast-cookie-id schreef. Die premisse is weg — de extractor
    // schrijft niets meer voor een guest_*-id (agents/memory/extractor.guest.test.js)
    // en de eerder geschreven rijen zijn gewist (migrations/memory-guest-purge-2026-08.js).
    // De router draagt nu router.use(requireAuth); de sweep ziet die gate
    // zelf. Bewezen door routes/memory.guards.test.js + routes/memory.authz.test.js.
]));

/**
 * The same claim for routes the static sweep cannot see (a regex path, a router
 * built by a factory, a mount the parser reads as opaque): keyed by the id the
 * router WALK reports (scripts/api-reference-walk.cjs), read only by the route
 * contract. The sweep test must not read this map: its stale-entry check would
 * find no sweep route behind these keys.
 */
/** @type {Map<string, OpenReason>} */
const OPEN_ROUTES_WALK_ONLY = new Map(/** @type {Array<[string, OpenReason]>} */ ([
    // ── Pre-session login flow: the request IS the credential, or there is none yet ──
    ['GET /auth/setup-status', 'first-run probe for the setup screen: answers only whether an operator account exists yet; the login page needs it before any session'],
    ['POST /auth/setup', 'first-run operator setup: refused by the handler as soon as an operator account exists (auth/login/setupRoutes.js), after that the route is inert'],
    ['GET /auth/organizations/public', 'the organisations that allow self-signup, for the signup form: names only, needed before any session (auth/login/signupIntakeRoutes.js)'],
    ['POST /auth/forgot-password', 'password reset request: always answers 200, mails a one-hour hashed token, throttled per address and IP (auth/login/passwordResetRoutes.js)'],
    ['POST /auth/reset-password', 'password reset completion: the e-mailed token is the credential, compared by hash and single-use (auth/login/passwordResetRoutes.js)'],
    ['GET /auth/verify-email/:token', 'e-mail verification link: the mailed token is the credential, single-use (auth/login/emailVerificationRoutes.js)'],
    ['POST /auth/resend-verification', 'resends the verification mail to the address on file; answers the same whether the address exists, throttled (auth/login/emailVerificationRoutes.js)'],
    ['GET /auth/invite/:token', 'invitation preview for the signup form: the mailed token is the credential; shows the org name and the invited address only (auth/login/inviteRoutes.js)'],
    ['GET /auth/redeem-invite/:token', 'invitation redeem link from the mail: parks the token on the pre-auth session and redirects to signup (auth/login/inviteRoutes.js)'],
    ['GET /auth/pending-invite', 'reads the invitation parked on the caller\'s own pre-auth session by the redeem link; nothing of anyone else (auth/login/inviteRoutes.js)'],
    ['POST /auth/pending-invite/clear', 'clears the invitation parked on the caller\'s own pre-auth session (auth/login/inviteRoutes.js)'],
    ['GET /auth/login', 'legacy Nextcloud login entry: starts the OAuth round trip for the Nextcloud app (auth/oauth/nextcloudLegacyRoutes.js); the provider is the authenticator'],
    ['GET /auth/login/:provider', 'OAuth login start: writes state and PKCE to the pre-auth session and redirects to the identity provider (auth/oauth/providerLoginRoutes.js)'],
    ['GET /auth/login-pickup', 'one-time claim of the session token an OAuth popup deposited under a pickup id, for iframes that cannot see the cookie (auth/oauth/loginPickupRoutes.js); the id is minted per login'],
    ['POST /auth/opaque/login/finish', 'second half of the OPAQUE password exchange: the OPAQUE proof is the credential, bound to the state /opaque/login/start put on the session (auth/opaqueRoutes.js)'],
    ['POST /auth/mfa/security-key/options', 'second-factor step of a login: works only on a session that holds mfaPending from the password step (auth/securityKeys/loginRoutes.js)'],
    ['POST /auth/mfa/security-key/verify-login', 'second-factor step of a login: the WebAuthn assertion is the credential, checked against the mfaPending user (auth/securityKeys/loginRoutes.js)'],
    ['POST /auth/logout', 'ends the caller\'s own session; without a session it is a no-op answered 200 (auth/login/profileRoutes.js)'],

    // ── Nextcloud connector bootstrap: the Nextcloud instance proves itself in the handler ──
    ['POST /auth/connector/bootstrap', 'connector pairing: the handler verifies the calling Nextcloud by its capabilities round trip and a pairing code or an existing binding before it answers anything (auth/connectorBootstrap.js)'],
    ['POST /auth/connector/diagnose', 'connector diagnostics: the same capabilities round trip as bootstrap, answers reachability and binding state only (auth/connectorBootstrap.js)'],
    ['GET /auth/connector/bootstrap/pending/:id', 'polls the approval state of a pending binding; the random id is the credential and yields status only, never the tenant key (auth/connectorBootstrap.js header)'],
    ['POST /auth/connector/bootstrap/pending/:id/verify', 'redeems the e-mailed verification code for a pending binding: the code is the credential, attempts are capped (auth/connectorBootstrap.js)'],
    ['POST /auth/connector/bootstrap/pending/:id/resend', 'resends the verification mail for a pending binding, rate limited per IP (auth/connectorBootstrap.js)'],
    ['POST /auth/connector/bootstrap/pending/:id/retarget', 'changes the address the verification mail goes to, under the same pending-binding id and limiter (auth/connectorBootstrap.js)'],

    // ── Published website content: anonymous visitors and crawlers are the audience ──
    ['GET /api/cms/blog/posts', 'published blog posts of the live site, for the public blog page (routes/cmsBlog.js reads the published snapshot only)'],
    ['GET /api/cms/stories', 'published customer stories of the live site, for the public page (routes/cmsStories.js, published snapshot only)'],
    ['POST /api/cms/forms/:blockId', 'public form submission from a published page: honeypot, HMAC token with issue time, nonce replay refusal, per-IP and per-form limits (routes/cmsForms.js)'],
    ['GET /api/cms/^\\/asset\\/(.+)$/', 'assets of published marketing pages (sanitised SVG, raster images) served from the CMS asset keys (routes/cmsAssets.js)'],
    ['GET /api/cms/^\\/og\\/([a-z]{2,3})\\/([a-z0-9][a-z0-9-]*)\\.png$/', 'og:image for a published page, rendered from the published snapshot only (routes/cmsOgImage.js)'],
    ['GET /^\\/(?:([a-z]{2,3})\\/)?search-index\\.json$/', 'the public site search index, built from published pages (routes/publicSearchIndexRender.js)'],
    ['GET /integrations/directory', 'server-rendered public integrations directory of the marketing site (routes/publicIntegrationsRender.js)'],
    ['GET /integrations/:id', 'server-rendered public page of one integration, same source as the directory (routes/publicIntegrationsRender.js)'],
]));

module.exports = { OPEN_ROUTES, OPEN_ROUTES_WALK_ONLY };
