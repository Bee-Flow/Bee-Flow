/**
 * CMS Defaults — schema-of-record for the website builder.
 *
 * Two tiers:
 *   SITE_DEFAULTS   site-wide chrome (header, footer, cookieBanner, announcement)
 *                   + empty nav scaffold
 *   BLOCK_DEFAULTS  per-block-type seed content; used by:
 *                     - cmsStore.makeBlock() for any server-side block creation
 *                     - the admin panel ALSO ships its own client-side
 *                       BLOCK_DEFAULTS in editors.jsx — keep the two in sync
 *
 * Link value object — used for every URL in the schema:
 *   { kind: 'page',     pageId, anchor? }
 *   { kind: 'external', url, newTab? }
 *   { kind: 'anchor',   anchor }
 *   { kind: 'app',      path }       // routes that hand off to the host SPA
 *
 * Image fields hold either a full URL or a RustFS storage key under cms/.
 * The public site resolves keys via /api/cms/asset/:key.
 */

// ── Site-wide defaults (header / footer / cookie banner / announcement) ──
//
// Brand-neutral. A fresh site has empty nav and empty footer columns —
// the user fills them in once they've decided what their pages and
// anchors look like.

const SITE_DEFAULTS = {
    header: {
        enabled: true,
        // logoText is the legacy field; new sites also expose `logo` so
        // the editor's Logo & brand panel has somewhere to land its
        // edits. Header.jsx prefers logo.text when present.
        logoText: 'My Website',
        logo: {
            src: '',           // empty = letter-avatar fallback
            text: 'My Website',
            textColor: '',     // empty = inherit from CSS
            fontSize: 'medium',// 'small' | 'medium' | 'large'
            url: '/',
            showDot: false,    // opt-in "." flourish after the brand name
        },
        // Legacy single-CTA fields kept so old sites' lazy migration can
        // read them when seeding `ctas`. New sites just use `ctas` below.
        loginLabel: '',
        ctaLabel: '',
        ctaLink: { kind: 'anchor', anchor: '' },
        // Multi-CTA — one filled "Get started" button by default. Users
        // add Log in / Sign up / etc. via Site chrome → Header buttons.
        ctas: [
            {
                id: 'cta_default',
                label: 'Get started',
                link: { kind: 'app', path: '/app' },
                style: 'primary',
            },
        ],
        nav: [],
    },
    footer: {
        enabled: true,
        brandText: 'My Website',
        blurb: '',
        columns: [],
        socials: [],
        copyright: '© My Website',
        // Trust surface: physical address / registration ids / legal links.
        // The renderer hides the row while every field is empty.
        accountability: { address: '', registration: '', vat: '', links: [] },
        // Text-only EN / NL toggle in the footer bottom bar.
        showLanguageSwitcher: false,
        // Opt-in "." flourish after the footer brand name (mirrors
        // header.logo.showDot).
        showBrandDot: false,
    },
    // Site-wide cookie consent banner. `text` carries every locale's copy
    // in one blob; the renderer picks the visitor's language at display
    // time, so the banner needs no per-locale override layer. enabled:true
    // means a fresh site shows the banner until the visitor chooses.
    cookieBanner: {
        enabled: true,
        text: {
            en: {
                message: 'We use cookies to improve your experience.',
                accept: 'Accept',
                decline: 'Decline',
                privacyLabel: 'Privacy Policy',
                privacyUrl: '/privacy',
            },
            nl: {
                message: 'Wij gebruiken cookies om je ervaring te verbeteren.',
                accept: 'Accepteren',
                decline: 'Weigeren',
                privacyLabel: 'Privacybeleid',
                privacyUrl: '/privacy',
            },
        },
    },
    // Site-wide announcement bar — a dismissible strip ABOVE the header
    // (the UiPath/Microsoft pattern). Same one-blob-per-locale shape as
    // cookieBanner: `text` carries every locale's copy, the renderer picks
    // the visitor's language at display time, so no per-locale override
    // layer is needed.
    //
    // enabled:false by default — an existing site must not suddenly grow a
    // strip above its header when this field lands.
    //   dismissible  show the close button + remember the dismissal
    //   variant      'accent' | 'surface' | 'dark' (visual register)
    announcement: {
        enabled: false,
        dismissible: true,
        variant: 'accent',
        text: {
            en: { message: '', linkLabel: '', linkUrl: '' },
            nl: { message: '', linkLabel: '', linkUrl: '' },
        },
    },
    // Site-level analytics wiring. `gaMeasurementId` is a Google Analytics 4
    // measurement id ("G-XXXXXXXXXX"); empty string = GA tracking off. The
    // public /api/cms/site route only emits a `ga` config when this is a
    // valid-looking id (cmsStore.sanitizeAnalytics enforces the format).
    analytics: {
        gaMeasurementId: '',
    },
};

// ── Per-block-type defaults ──────────────────────────────────────────
//
// Each entry is the `content` shape for a block of that type. `enabled`
// is a block-level flag (lifted out of content) and is set when a block
// is created, not stored here.
//
// Content is brand-neutral placeholder text. Any CTA links use
// { kind: 'anchor', anchor: '' } so newly-added buttons don't point at
// app routes the user hasn't created.

const BLOCK_DEFAULTS = {
    hero: {
        eyebrow: '',
        // Each toggle-able piece carries an `enabled: true` flag so the
        // editor's "Show …" toggles can flip it off. Old hero blocks
        // stored without these fields render as before because the
        // renderer treats missing `enabled` as truthy via `!== false`.
        badge: { enabled: true, text: '', icon: '' },
        // Per-text styling — empty strings / 0 = inherit the page CSS
        // and the Design tab. Old blocks read these as undefined and
        // the renderer skips inline-style application.
        badgeStyle: { fontFamily: '', fontSize: 0, color: '' },
        titleParts: [
            { text: 'Your headline here', gradient: false },
        ],
        titleStyle: { fontFamily: '', fontSize: 0, color: '' },
        lead: 'Describe your product or service',
        leadStyle: { fontFamily: '', fontSize: 0, color: '' },
        // CTAs grew an explicit `style` field (matching site-chrome /
        // multi-CTA patterns) and an `enabled` toggle. Defaults preserve
        // the original visual: primary = filled, secondary = outline.
        primaryCta:   { enabled: true, label: 'Get started', style: 'primary',   link: { kind: 'anchor', anchor: '' } },
        secondaryCta: { enabled: true, label: 'Learn more',  style: 'secondary', link: { kind: 'anchor', anchor: '' } },
        mockup: { enabled: true, chatBubbles: [] },
        // 'default' / 'surface' / 'primary' / 'dark' — same scale as
        // Media + Text and Content blocks. Default keeps the page bg.
        backgroundVariant: 'default',
        // Layout variant (see BLOCK_VARIANTS). New heroes default to the
        // premium 'panel' layout; stored blocks without the key render
        // 'classic'. The media slot uses the shared FramedMedia shape —
        // empty src renders an intentional skeleton panel (never invent
        // asset keys).
        variant: 'panel',
        media: { src: '', srcDark: '', alt: '', frame: 'browser', kind: 'image' },
    },

    socialProof: {
        eyebrow: 'Add your client logos',
        title: '',
        // Empty fields = inherit page CSS / Design tab. Old blocks saved
        // without these keys read as `undefined` and the renderer skips
        // inline-style application, so backwards-compat is free.
        eyebrowStyle: { fontFamily: '', fontSize: 14, color: '' },
        titleStyle:   { fontFamily: '', fontSize: 32, color: '' },
        logos: [],
        // 'classic' = logo wall only; 'numbers' adds a hard-numbers row
        // (stars / users / uptime) above the wall. See BLOCK_VARIANTS.
        variant: 'classic',
        stats: [],
    },

    // Flexible Content block — column + elements system. Each column holds
    // a stack of typed elements (text / image / video / iframe / cta). The
    // renderer and editor accept the legacy flat shape via
    // migrateLegacyContent() in agent-hub/src/marketing/sections/
    // contentMigration.js, so existing blocks keep working until they're
    // saved (the next save persists the new shape).
    content: {
        columnLayout: '1',
        verticalAlign: 'top',
        background: 'none',
        columns: [
            {
                id: 'col_default',
                elements: [
                    {
                        id: 'el_default',
                        kind: 'text',
                        heading: 'Your heading here',
                        subheading: '',
                        body: 'Add your content here.',
                        align: 'left',
                    },
                ],
            },
        ],
    },

    // Media + Text — side-by-side layout with image OR video on one side
    // and copy on the other. Media is always rendered (placeholder when
    // src is empty); subheading and CTA are togglable optional pieces.
    'media-text': {
        heading:           'Your heading here',
        subheading:        null,
        body:              'Add your content here.',
        cta:               null,                       // { label, link: { kind, ... } }
        media: {
            kind: 'image',                              // 'image' | 'video'
            src:  '',                                   // image URL/asset key OR video embed URL
            alt:  '',                                   // image only
            srcDark: '',                                // optional dark-theme image (framed rendering)
            frame:   '',                                // '' (legacy bare img) | 'hairline' | 'browser'
        },
        mediaPosition:     'left',                     // 'left' | 'right'
        mediaSize:         'half',                     // 'half' | 'third' | 'two-thirds'
        backgroundVariant: 'default',                  // 'default' | 'surface' | 'primary' | 'dark'
    },

    features: {
        eyebrow: 'Features',
        title: 'What we offer',
        lead: '',
        // 'bento' (default for new blocks) = asymmetric grid; per-item
        // `span` (1|2) and an optional `media` slot (shared FramedMedia
        // shape — never invent asset keys, empty src renders a skeleton).
        // Stored blocks without `variant` render the classic 3-up grid.
        variant: 'bento',
        spotlight: false,
        items: [
            { icon: 'Star',   title: 'Feature 1', body: 'Describe this feature', techTag: '', span: 2, media: { src: '', srcDark: '', alt: '', frame: 'hairline', kind: 'image' } },
            { icon: 'Zap',    title: 'Feature 2', body: 'Describe this feature', techTag: '', span: 1, media: { src: '', srcDark: '', alt: '', frame: 'hairline', kind: 'image' } },
            { icon: 'Shield', title: 'Feature 3', body: 'Describe this feature', techTag: '', span: 1, media: { src: '', srcDark: '', alt: '', frame: 'hairline', kind: 'image' } },
        ],
    },

    steps: {
        eyebrow: '',
        title: 'How it works',
        lead: '',
        // 'chapters' (default for new blocks) = numbered full-width
        // chapters with per-step media slots; stored blocks without
        // `variant` keep the classic 3-up cards. See BLOCK_VARIANTS.
        variant: 'chapters',
        items: [
            { number: '1', title: 'Step 1', body: 'Describe what happens in this step', example: '', media: { src: '', srcDark: '', alt: '', frame: 'hairline', kind: 'image' } },
            { number: '2', title: 'Step 2', body: 'Describe what happens in this step', example: '', media: { src: '', srcDark: '', alt: '', frame: 'hairline', kind: 'image' } },
            { number: '3', title: 'Step 3', body: 'Describe what happens in this step', example: '', media: { src: '', srcDark: '', alt: '', frame: 'hairline', kind: 'image' } },
        ],
    },

    security: {
        eyebrow: '',
        title: 'Security',
        lead: '',
        // 'ledger' = 5/7 split with sticky header + mono-indexed hairline
        // rows; stored blocks without `variant` keep the classic 2-up card
        // grid. Per-card `link` renders as a "→ label" external link on
        // the ledger row (empty = hidden). See BLOCK_VARIANTS.
        variant: 'classic',
        cards: [
            { icon: 'Lock',        title: 'Data encryption', summary: 'Describe your encryption story', details: [], link: { label: '', href: '' } },
            { icon: 'KeyRound',    title: 'Access control',  summary: 'Describe your access controls',  details: [], link: { label: '', href: '' } },
            { icon: 'ShieldCheck', title: 'Compliance',      summary: 'Describe your compliance posture', details: [], link: { label: '', href: '' } },
        ],
    },

    integrations: {
        eyebrow: '',
        title: 'Integrations',
        lead: 'Add your integrations',
        categories: [],
    },

    architecture: {
        eyebrow: '',
        title: 'Architecture',
        lead: 'Describe your architecture',
        layers: [
            { label: 'Layer 1', tags: [] },
        ],
    },

    techStats: {
        eyebrow: '',
        title: 'Key numbers',
        stats: [
            { number: '100+', label: 'Customers' },
            { number: '99%',  label: 'Uptime' },
            { number: '24/7', label: 'Support' },
        ],
    },

    cta: {
        title: 'Ready to get started?',
        lead:  'Contact us today',
        button: { label: 'Get started', link: { kind: 'anchor', anchor: '' } },
        // Page-closing band: hex-motif echo on by default; new blocks
        // ship the dark polarity flip; optional ghost secondary CTA
        // (null = none — never two filled buttons in one band).
        secondaryCta: null,
        showMotif: true,
        backgroundVariant: 'dark',
    },

    // CTA Banner — louder Conversion block. Two layouts (centered vs split),
    // four background variants (defaulting to 'primary' for visual punch),
    // primary CTA always rendered, secondary CTA toggleable. Both CTAs use
    // the Link union for page-picker support.
    'cta-banner': {
        heading:           'Ready to get started?',
        subheading:        'Join thousands of teams already using the platform.',
        layout:            'centered',                  // 'centered' | 'split'
        backgroundVariant: 'primary',                   // 'default' | 'surface' | 'primary' | 'dark'
        primaryCta: {
            label: 'Get started',
            link: { kind: 'external', url: '', newTab: false },
        },
        secondaryCta:      null,                        // null | { label, link: { kind, ... } }
    },
    // Live Component — pasted HTML/CSS/JS rendered in a sandboxed iframe.
    // `layout` picks the column structure ('full' | 'two-components' |
    // 'component-text' | 'component-cta'). CTA is a nested
    // { enabled, label, link, style } blob — same shape as the Hero
    // primary/secondary CTAs and the LinkField persistence format.
    'live-component': {
        layout:    'full',
        code:      '',
        codeRight: '',
        heading:   '',
        body:      '',
        // Per-field typography overrides. Empty / 0 = inherit: the
        // renderer applies the `content-el-heading` class, so by default
        // the heading renders at the Content block's main-heading scale
        // (clamp 1.6–2.25rem, weight 700) — not the smaller subheading
        // scale. Concrete values set in the editor override these.
        headingStyle: { fontFamily: '', fontSize: 0, fontWeight: 0, color: '' },
        bodyStyle:    { fontFamily: '', fontSize: 0, fontWeight: 0, color: '' },
        cta: {
            enabled: true,
            label:   'Get started',
            link:    { kind: 'external', url: '', newTab: false },
            style:   'primary',
        },
    },

    // Pricing — dynamic. Plans come from /api/billing/public-plans;
    // the admin chooses an audience (planType) and toggle defaults
    // here. Kept in sync with the admin panel's BLOCK_DEFAULTS in
    // editors.jsx.
    pricing: {
        heading: 'Pricing',
        subheading: '',
        planType: 'organization',
        enableToggle: true,
        defaultInterval: 'monthly',
        toggleLabelMonthly: 'Maandelijks',
        toggleLabelYearly: 'Jaarlijks',
        ctaLabel: 'Kies plan',
        emptyText: 'Geen plannen beschikbaar',
        // Previously hardcoded Dutch strings — now content fields (and so
        // translatable). Absent fields fall back to the old literals.
        suffixMonthly: '/maand',
        suffixYearly: '/jaar',
        customPriceText: 'Op aanvraag',
        trialText: '{days} dagen gratis proberen',
        // Featured tier: the plan id to emphasize ('' = none, all CTAs
        // filled as before) + treatment ('border' = 2px accent border,
        // 'flip' = polarity-flip dark card).
        featuredPlanId: '',
        featuredStyle: 'border',
    },

    // Customer Support — public AI-first support form. Submits to
    // POST /api/support/threads (source: 'marketing'); the AI replies inline
    // and a human takes over on escalation. Kept in sync with the admin
    // panel's BLOCK_DEFAULTS in editors.jsx.
    'customer-support': {
        title: 'Talk to us',
        lead: 'Question about pricing, custom deployments, or anything else? Send us a note — our AI assistant replies within seconds, and a human picks it up if needed.',
        nameLabel: 'Your name',
        namePlaceholder: 'Jane Doe',
        emailLabel: 'Email',
        emailPlaceholder: 'you@company.com',
        subjectLabel: 'Subject',
        subjectPlaceholder: 'How can we help?',
        messageLabel: 'Message',
        messagePlaceholder: "Tell us about your team, what you're trying to do, and any constraints.",
        submitLabel: 'Send to Bee Flow',
        successTitle: "Thanks — we've got your message",
        successBody: "Our AI assistant is looking through our knowledge base right now and you'll receive an email reply within a few minutes. If it can't fully resolve your question, a Bee Flow teammate will take over.",
        backgroundVariant: 'surface',
    },

    // Testimonials — quantified social proof (name + role + company always;
    // NEVER star ratings). 'quotes' (default) = 3-up hairline cards; 'case'
    // leads each card with metric.number/label; 'spotlight' renders only the
    // FIRST item as an oversized photo + quote split (photo = avatarSrc).
    // Kept in sync with the admin panel's BLOCK_DEFAULTS in catalogue.js.
    testimonials: {
        variant: 'quotes',
        eyebrow: 'What teams say',
        title: 'Trusted by teams that ship',
        items: [
            { quote: 'We replaced three tools in the first week. Nobody has asked for them back.', name: 'Sanne de Vries', role: 'Head of Operations', company: 'Fjord Analytics', avatarSrc: '', logoSrc: '', metric: { number: '', label: '' } },
            { quote: 'Setup took an afternoon. The privacy review took even less — everything stays on our own servers.', name: 'Jonas Weber', role: 'CTO', company: 'Kompas Legal', avatarSrc: '', logoSrc: '', metric: { number: '', label: '' } },
            { quote: 'The first platform our whole team adopted without being pushed.', name: 'Elena Rossi', role: 'Product Lead', company: 'Brightloop', avatarSrc: '', logoSrc: '', metric: { number: '', label: '' } },
        ],
    },

    // FAQ — controlled accordion (one item open at a time, first open by
    // default so an answer is always visible). Single layout, no variants.
    faq: {
        eyebrow: 'FAQ',
        title: 'Questions, answered',
        lead: '',
        items: [
            { question: 'How long does setup take?', answer: 'Most teams are up and running within a day. Connect your data, invite your team, and start working — no consultants required.' },
            { question: 'Where is our data stored?', answer: 'On your own infrastructure, or in the EU region you choose. Nothing leaves your environment without your say-so.' },
            { question: 'Can we try it before committing?', answer: 'Yes — start small with a pilot team and expand when it proves itself. You keep full control the whole way.' },
            { question: 'What happens if we want to leave?', answer: 'Your data is yours. Export everything in open formats at any time — no lock-in, no exit fees.' },
        ],
    },

    // Trust band — monochrome institutional chips (GDPR / zero-knowledge /
    // fair-code register). 'chips' (default) = centered pill row, sublabels
    // hidden; 'detailed' = small cards showing the sublabel. A chip with an
    // href renders as an external link (new tab). Bright by design — dark
    // treatments come from style.band, never baked into the block.
    'trust-band': {
        variant: 'chips',
        eyebrow: 'Built for European teams',
        title: '',
        chips: [
            { icon: 'ShieldCheck', label: 'GDPR-compliant', sublabel: 'EU data residency', href: '' },
            { icon: 'Lock', label: 'Zero-knowledge encryption', sublabel: 'Not even we can read your data', href: '' },
            { icon: 'Scale', label: 'Fair-code licensed', sublabel: 'Source available, auditable', href: '' },
        ],
    },

    // Showcase — staged product proof. 'single' (default) = full-container
    // framed shot with glow + fade-mask; 'pair' = media + mediaSecondary side
    // by side; 'code-ui' = mono code panel + frame (5/7, no highlighting).
    // `code` sits on the translation denylist (structural subtree), so
    // snippet/language are never sent to the translator.
    // Live feature demo — frames the REAL product UI at /__demo__/<feature>
    // so a visitor can use the feature on the marketing site.
    //
    // `feature` is an ID from the frontend demo registry, NOT a URL. That is
    // deliberate: the renderer builds the src itself, so no editor (and no AI
    // builder turn) can ever point this block at a third-party origin. An
    // unknown id renders an explanatory placeholder instead of an iframe.
    //
    // The demo is fixture-backed and cannot reach the network — see
    // agent-hub/src/demo/demoTransport.js. `note` is the line shown under
    // the frame; it should keep saying so.
    'feature-demo': {
        eyebrow: 'Live demo',
        title: 'Try it right here',
        lead: '',
        feature: 'automations',
        height: 720,
        theme: 'light',                 // 'light' | 'dark' — passed to the demo
        note: 'This is the real interface running on sample data. Nothing you do here is saved, and nothing leaves your browser.',
        // No default CTA under the frame — the demo itself is the pitch. An
        // authored cta { label, link } still renders if a block carries one.
    },

    // Public roadmap. Items are grouped into status buckets AT RENDER TIME,
    // never stored in sorted order — locale overrides address array items by
    // numeric index, so reordering `items` in the default locale would drag
    // every translation onto the wrong item.
    //
    // `item.status` is a fixed vocabulary and therefore STRUCTURAL: it is on
    // the translation denylist (server/core/cmsTranslate.js) so the AI
    // translator cannot turn 'beta' into 'bèta' and drop the item out of
    // every bucket. `statusLabels` is the prose half and does translate.
    //
    // Deliberately no date, quarter or version field. terms.md disclaims
    // uninterrupted operation, and a roadmap that prints "Q3" reads as a
    // commitment; beeflowSite.test.js enforces that no date reaches the copy.
    roadmap: {
        eyebrow: 'Roadmap',
        title: 'What we are building',
        lead: '',
        statusLabels: {
            shipped:   'Available now',
            beta:      'In beta',
            building:  'In development',
            exploring: 'Exploring',
        },
        showLegend: true,
        items: [],
        disclaimer: 'This page describes what we are working on, not what we promise to deliver or when.',
    },

    showcase: {
        variant: 'single',
        eyebrow: '',
        title: 'See it working',
        lead: '',
        media: { src: '', srcDark: '', alt: '', frame: 'browser', kind: 'image' },
        mediaSecondary: { src: '', srcDark: '', alt: '', frame: 'browser', kind: 'image' },
        code: { language: 'bash', snippet: 'docker compose up -d' },
    },

    // Feature-for-feature table for the comparison pages. Rows are
    // { aspect, left, right } — `left` is always our side (leftLabel), so a
    // renderer never has to guess which column is the product's.
    'compare-table': {
        eyebrow: '',
        title: '',
        lead: '',
        leftLabel: 'Bee Flow',
        rightLabel: '',
        rows: [],
        footnote: '',
    },

    // Live repository facts (stars, latest release) fetched client-side from
    // /api/public/github-stats. The block itself stores no numbers — stored
    // star counts would be stale the week after publishing.
    'github-stats': {
        eyebrow: '',
        title: '',
        lead: '',
        repoUrl: 'https://github.com/Bee-Flow/Bee-Flow',
        linkLabel: 'Source on GitHub',
    },

    // Published changelog. The ENTRIES are not stored here — they come from
    // `GET /api/release-notes/public`, the same arrangement `github-stats`
    // uses. Two reasons that is deliberate: CMS publish is site-wide, so a
    // generated note living in block content would go live on the next
    // unrelated publish; and locale overrides address block array items by
    // numeric index, so a generator rewriting an `items` array would re-point
    // every existing translation. Everything below is presentation only.
    //
    // `kindLabels` is prose and DOES translate. There is deliberately no
    // `kind` field here — the bucket key lives on the API payload, out of the
    // translator's reach, which is the trap `roadmap.status` had to be
    // denylisted for.
    'release-notes': {
        variant: 'compact',
        eyebrow: '',
        title: 'What\'s new',
        lead: '',
        limit: 1,
        kindLabels: {
            feature: 'New',
            improvement: 'Improved',
            fix: 'Fixed',
        },
        emptyText: '',
        linkLabel: '',
        linkUrl: '',
    },
};

// ── Block type catalogue (drives the "Add block" picker) ─────────────

const BLOCK_TYPES = [
    { type: 'hero',         label: 'Hero',           icon: 'Megaphone',   category: 'Above the fold' },
    { type: 'socialProof',  label: 'Social proof',   icon: 'Users',       category: 'Above the fold' },
    { type: 'content',      label: 'Content',        icon: 'Type',             category: 'Content' },
    { type: 'media-text',   label: 'Media + Text',   icon: 'LayoutPanelLeft',  category: 'Content' },
    { type: 'features',     label: 'Features',       icon: 'Sparkles',         category: 'Content' },
    { type: 'steps',        label: 'How it works',   icon: 'ListOrdered', category: 'Content' },
    { type: 'security',     label: 'Security',       icon: 'ShieldCheck', category: 'Content' },
    { type: 'integrations', label: 'Integrations',   icon: 'Plug',        category: 'Content' },
    { type: 'architecture', label: 'Architecture',   icon: 'Boxes',       category: 'Content' },
    { type: 'techStats',    label: 'Stats',          icon: 'BarChart3',   category: 'Content' },
    { type: 'cta',          label: 'Call to action', icon: 'Target',           category: 'Conversion' },
    { type: 'cta-banner',   label: 'CTA Banner',     icon: 'Rocket',           category: 'Conversion' },
    { type: 'live-component', label: 'Live Component', icon: 'Code',           category: 'Content' },
    { type: 'pricing',      label: 'Pricing',        icon: 'CreditCard',    category: 'Conversion' },
    { type: 'customer-support', label: 'Customer Support', icon: 'LifeBuoy', category: 'Conversion' },
    // ROLLBACK CAVEAT: site exports containing the five types below,
    // imported into an OLDER deployment that doesn't know them, silently
    // drop those blocks (normalizeBlockRecord → unknown-type). Land schema
    // + renderer as one deploy unit; never enable these on a fleet that
    // still runs pre-2026-07 images.
    { type: 'testimonials', label: 'Testimonials',   icon: 'Quote',                  category: 'Trust' },
    { type: 'faq',          label: 'FAQ',            icon: 'MessageCircleQuestion',  category: 'Content' },
    { type: 'trust-band',   label: 'Trust band',     icon: 'ShieldCheck',            category: 'Trust' },
    { type: 'showcase',     label: 'Showcase',       icon: 'MonitorPlay',            category: 'Content' },
    { type: 'feature-demo', label: 'Live feature demo', icon: 'MousePointerClick',   category: 'Content' },
    { type: 'roadmap',      label: 'Roadmap',        icon: 'Milestone',              category: 'Trust' },
    // Same rollback caveat as the 2026-07 batch above: land schema + renderer
    // as one deploy unit.
    { type: 'compare-table', label: 'Comparison table', icon: 'Table',              category: 'Trust' },
    { type: 'github-stats',  label: 'GitHub stats',     icon: 'Github',             category: 'Trust' },
    { type: 'release-notes', label: 'Release notes',    icon: 'ScrollText',         category: 'Trust' },
];

const BLOCK_TYPE_IDS = BLOCK_TYPES.map(t => t.type);

// ── Per-type layout variants ─────────────────────────────────────────
//
// `content.variant` picks a layout treatment for a block. It's a CONTENT
// field (not style) so it deep-merges additively, rides export/import with
// zero plumbing, and appears in the AI-builder catalogue automatically.
// Renderers treat an absent/unknown variant as 'classic' (the legacy
// layout), so stored pages are untouched. Types not listed here have a
// single layout. Kept in sync with the admin panel's copy in
// agent-hub/src/components/admin/ProductWebsite/blockEditors/catalogue.js.
// NOTE for translators: `variant` is structural — it must stay on the
// translation denylist (server/core/cmsTranslate.js) so locale overrides
// can never change a page's layout.

// ── Live feature demos ───────────────────────────────────────────────
//
// The ids the `feature-demo` block may point at. The demos themselves live
// in the frontend (agent-hub/src/demo/registry.js) because each one mounts a
// real React component behind lazy() — which is exactly why this list has to
// be duplicated here: the AI builder and validate.js run server-side and
// cannot import that module. The frontend half is pinned by
// agent-hub/src/demo/DemoHost.test.jsx; keep the two in sync.
//
// An unknown id is not dangerous — the renderer builds the iframe src itself
// and shows a placeholder for anything it does not recognise, so this can
// never become an embed of a third-party origin. It just means a marketing
// page silently carries a dead panel, hence the validator warning.
const DEMO_FEATURE_IDS = [
    'automations', 'meeting-notes', 'agents', 'notebooks', 'privacy-shield',
    'support', 'skills', 'knowledge', 'legal', 'monitoring', 'compliance',
    'app-studio',
];

const BLOCK_VARIANTS = {
    hero:        ['classic', 'panel', 'split', 'video'],
    features:    ['classic', 'bento'],
    steps:       ['classic', 'chapters'],
    security:    ['classic', 'ledger'],
    socialProof: ['classic', 'numbers'],
    // New types have no legacy layout — the FIRST entry is the default and
    // the absent/unknown fallback (their renderers fall back to it, not to
    // a 'classic').
    testimonials: ['quotes', 'case', 'spotlight'],
    'trust-band': ['chips', 'detailed'],
    showcase:     ['single', 'pair', 'code-ui'],
    // compact = one entry for a homepage strip; full = the /changelog archive.
    'release-notes': ['compact', 'full'],
};

// Reserved slugs that must never become a CMS page (they collide with real
// app routes or the static marketing pages). Lowercase, no leading slash.
// Kept in sync with the CLIENT router's claim list in
// agent-hub/src/utils/cmsPublicRouting.js (RESERVED_TOP_LEVEL) — a slug the
// client router never routes to the CMS is unreachable even if stored.
// Enforced on page CREATE and slug RENAME only; the site-import path
// deliberately bypasses this (importSite → ensureUniqueSlug) so restoring an
// old export that predates an entry here never fails.
const RESERVED_SLUGS = new Set([
    'app', 'api', 'admin', 'auth', 'login', 'logout', 'register', 'signup',
    'dashboard', 'settings', 'embed', 'oauth', 'callback',
    // legacy short-id prefixes + app sub-surfaces claimed by App.jsx parsers
    'chat', 'd', 'a', 'agent',
    // hosted form-trigger pages: /f/<token> (routes/automation/formPublic.js)
    'f',
    // public Studio-app pages: /p/<token> (routes/studioAppPublic.js)
    'p',
    'org-settings',
    // static public pages (served from in-repo markdown / static components)
    // `pricing` was removed from this list (2026-07): the CMS now owns
    // /pricing and the hardcoded PricingPage is only the fallback. See
    // agent-hub/src/utils/cmsPublicRouting.js. `privacy`/`terms`/`legal`
    // stay — those are served from in-repo markdown at fixed URLs.
    'privacy', 'terms', 'legal',
    '__cms_preview__',
]);

// ── Design system defaults ───────────────────────────────────────────
//
// Every site ships with these values on `site.design`. The admin panel
// edits them as a unit and pushes the result to the iframe via the
// existing `cms-preview` postMessage. The marketing renderer maps each
// field to a CSS custom property on `.marketing-root`:
//
//   colors.*       → --brand-{primary|secondary|accent|bg|surface|text|text-secondary}
//   darkColors.*   → same --brand-* vars while the dark theme is active
//   fonts.heading  → --font-heading  (also drives the Google Fonts <link>)
//   fonts.body     → --font-body
//   fonts.mono     → --font-mono    (eyebrow labels, stats, inline code)
//   radius         → --radius-base   (px)
//   theme          → toggles class .cms-theme-dark
//   typography.*   → --display-max / --heading-weight / --text-body
//   motion         → toggles class .cms-motion--none / .cms-motion--subtle
//   grain          → toggles class .cms-grain (page-wide noise overlay)
//
// `preset` is provenance only ('european-warmth' | 'dark-hive' | 'custom')
// — the renderer never looks presets up; applying one materializes
// concrete values here. `logo` and `favicon` are CMS asset keys
// (cms/<file>) or full URLs.
//
// NOTE: sites that have ever been saved store the complete design blob
// as literals (sanitizeDesign always returns a full shape), so changing
// defaults below only affects new sites + fields that didn't exist yet.

const DESIGN_DEFAULTS = {
    colors: {
        primary:       '#F5A623',  // CTA, links, brand accent (amber-honey)
        secondary:     '#1F2937',  // dark contrast, headings background
        accent:        '#FFD166',  // tertiary highlight
        background:    '#FAF8F4',  // page bg — warm cream ("European Warmth")
        surface:       '#F3EFE7',  // card / section bg
        textPrimary:   '#1C1917',  // warm ink
        textSecondary: '#57534E',
    },
    // Dark-mode layout palette. primary/accent are optional per-mode brand
    // adjustments; empty string = reuse the light brand colors unchanged.
    darkColors: {
        background:    '#101012',
        surface:       '#17171B',
        textPrimary:   '#F4F2EE',
        textSecondary: '#A6A29A',
        primary:       '',
        accent:        '',
    },
    fonts: {
        heading: 'Fraunces',
        body:    'Inter',
        mono:    'IBM Plex Mono',
    },
    logo:     '',
    favicon:  '',
    radius:   12,
    theme:    'light',
    gradient: false,            // when true, --accent-gradient becomes a linear-gradient
    preset:   'custom',
    typography: {
        displaySize:   'lg',    // 'md' | 'lg' | 'xl' → caps the display clamp at 64/80/96px
        headingWeight: 600,     // 500 | 600 | 700 — premium formula keeps headings ≤600
        bodySize:      16,      // 16 | 17 | 18 (px)
    },
    motion: 'full',             // 'none' | 'subtle' | 'full'
    grain:  false,              // subtle page-wide noise overlay

    // ── Component shape + size ───────────────────────────────────────
    // Every value below is the IDENTITY value: applyDesignToRoot emits no
    // inline property and adds no root class for it, and every CSS
    // consumer is written var(--token, <the literal that was always
    // there>). So a site with these defaults — or with the whole group
    // missing — renders byte-identically to before the theme system.
    components: {
        buttonShape:     'soft',      // pill | soft | rounded | sharp ('soft' = radius-xl)
        buttonSize:      'md',        // sm | md | lg
        buttonTextColor: 'light',     // light | dark | auto (auto = from primary's luminance)
        navStyle:        'bar',       // bar | floating | bordered
        navHeight:       'default',   // compact 60px | default 72px | tall 88px
        logoSize:        'md',        // sm 30px | md 38px | lg 46px
        cardStyle:       'hairline',  // hairline | soft | flat | elevated
        cardPadding:     'default',   // compact .75× | default 1× | roomy 1.3×
        shadow:          'soft',      // none | soft | medium | strong
    },
    layout: {
        containerWidth:  'default',   // narrow 1120 | default 1280 | wide 1440 | full 1760
        sectionRhythm:   'default',   // tight | default | airy
    },
};

// Legal values for the shape/size enums. Exported so sanitizeDesign, the AI
// builder's design tool and its validator all agree on one source of truth.
const DESIGN_COMPONENT_ENUMS = {
    buttonShape:     ['pill', 'soft', 'rounded', 'sharp'],
    buttonSize:      ['sm', 'md', 'lg'],
    buttonTextColor: ['light', 'dark', 'auto'],
    navStyle:        ['bar', 'floating', 'bordered'],
    navHeight:       ['compact', 'default', 'tall'],
    logoSize:        ['sm', 'md', 'lg'],
    cardStyle:       ['hairline', 'soft', 'flat', 'elevated'],
    cardPadding:     ['compact', 'default', 'roomy'],
    shadow:          ['none', 'soft', 'medium', 'strong'],
};
const DESIGN_LAYOUT_ENUMS = {
    containerWidth: ['narrow', 'default', 'wide', 'full'],
    sectionRhythm:  ['tight', 'default', 'airy'],
};

// Scalar design enums (shared with the AI design tool so its rejections can
// name the legal set instead of guessing).
const DESIGN_THEMES   = ['light', 'dark'];
const DESIGN_MOTIONS  = ['none', 'subtle', 'full'];
const DISPLAY_SIZES   = ['md', 'lg', 'xl'];
const HEADING_WEIGHTS = [500, 600, 700];
const BODY_SIZES      = [16, 17, 18];
const COLOR_KEYS      = Object.keys(DESIGN_DEFAULTS.colors);
const DARK_COLOR_KEYS = Object.keys(DESIGN_DEFAULTS.darkColors);

// Font allowlist — mirrors the curated FONT_LIBRARY in
// agent-hub/src/components/admin/ProductWebsite/googleFonts.js. There was no
// server-side font list before, so an AI-invented family would persist and
// then 404 against Google Fonts, silently falling back to a system face.
// Keep the two in sync (guarded by themePresets.test.js).
const DESIGN_FONTS = [
    // sans
    'Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Nunito',
    'Source Sans 3', 'Work Sans', 'IBM Plex Sans', 'DM Sans', 'Manrope',
    'Space Grotesk', 'Karla', 'Raleway', 'Geist',
    // serif / editorial display
    'Roboto Slab', 'Source Serif 4', 'Merriweather', 'Playfair Display', 'Lora',
    'IBM Plex Serif', 'Fraunces',
    // mono
    'IBM Plex Mono', 'Geist Mono', 'JetBrains Mono',
    // self-hosted (Fontshare originals under agent-hub/public/fonts/)
    'Satoshi', 'Cabinet Grotesk', 'General Sans', 'Clash Display', 'Clash Grotesk',
];

module.exports = {
    SITE_DEFAULTS,
    BLOCK_DEFAULTS,
    BLOCK_TYPES,
    BLOCK_TYPE_IDS,
    BLOCK_VARIANTS,
    DEMO_FEATURE_IDS,
    RESERVED_SLUGS,
    DESIGN_DEFAULTS,
    DESIGN_COMPONENT_ENUMS,
    DESIGN_LAYOUT_ENUMS,
    DESIGN_THEMES,
    DESIGN_MOTIONS,
    DISPLAY_SIZES,
    HEADING_WEIGHTS,
    BODY_SIZES,
    COLOR_KEYS,
    DARK_COLOR_KEYS,
    DESIGN_FONTS,
};
