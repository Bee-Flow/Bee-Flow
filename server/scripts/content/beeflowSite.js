/**
 * The Bee Flow marketing website, as a v2 CMS export bundle.
 *
 * WHY THIS IS DATA AND NOT A SEQUENCE OF API CALLS
 * The site is expressed in exactly the format `GET /sites/:id/export`
 * produces, so seeding it is one `importSite()` call — which means creating
 * the site also exercises the import path end to end, and the file doubles
 * as a fixture you can diff against a later export.
 *
 * WHERE THE COPY COMES FROM
 * Every factual claim below is traceable to code in this repo. That
 * constraint removed several things the README still advertises:
 *   • no SAML/OIDC IdP — `sso_saml` is a licence-flag name; there is no ACS
 *     route, no metadata endpoint, no SAML dependency. SSO here means
 *     Google, Microsoft and Nextcloud OAuth, and that is what the copy says.
 *   • no desktop/Android/PWA apps — no Electron, Tauri, Capacitor, service
 *     worker or web app manifest exists.
 *   • no Google Meet bot — nothing joins a call. Bee Flow imports Meet's own
 *     generated recordings afterwards. (Nextcloud Talk auto-record is real.)
 *   • no content moderation — the Azure Content Safety backend was removed.
 *   • Slack is reachable as an MCP server, not as a native integration.
 *   • 21 PII categories, not 28.
 * There is also no invented social proof: no customer logos, no testimonials,
 * no user counts. The `testimonials` block is deliberately unused — the
 * honest alternative to fabricated quotes is not having the section.
 *
 * NAMING NOTE: `/pricing` is reserved
 * app routes (RESERVED_SLUGS + App.jsx), so the pricing page lives at /plans
 * and the legal pages are linked, not recreated.
 */

const { BLOCK_DEFAULTS } = require('../../i18n/defaults/cmsDefaults');
const { KEYS, shot, og } = require('./beeflowAssets');

// ── Tiny builders ────────────────────────────────────────────────────

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** Deep-merge content over the block-type default. Arrays replace wholesale. */
function merge(base, patch) {
    if (!isObj(patch)) return patch === undefined ? base : patch;
    if (!isObj(base)) return JSON.parse(JSON.stringify(patch));
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) out[k] = merge(base[k], v);
    return out;
}

/**
 * Blank the `frame` on any media slot that has no image.
 *
 * A frame is a request to draw a bordered panel; with no `src` behind it the
 * renderer has nothing to put inside and draws a placeholder instead. Nine of
 * those shipped to the public site before anyone noticed. The screenshots
 * here are supplied by the operator and may legitimately be absent — `shot()`
 * returns '' — so rather than police ~60 call sites, the rule is applied once,
 * on the way into every block: no image, no frame.
 */
function dropEmptyFrames(node) {
    if (Array.isArray(node)) return node.map(dropEmptyFrames);
    if (!isObj(node)) return node;
    const isMediaSlot = Object.prototype.hasOwnProperty.call(node, 'src')
        && Object.prototype.hasOwnProperty.call(node, 'frame');
    if (isMediaSlot && !String(node.src || '').trim()) {
        return { ...node, frame: '' };
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = dropEmptyFrames(v);
    return out;
}

let blockSeq = 0;
/**
 * A block, filled out from BLOCK_DEFAULTS so no renderer ever meets a
 * missing field. Ids are sequential and deterministic — import mints fresh
 * ones anyway, but a stable id keeps this file diffable.
 */
function b(type, content = {}, style = {}) {
    if (!BLOCK_DEFAULTS[type]) throw new Error(`Unknown block type in seed content: ${type}`);
    blockSeq += 1;
    return {
        id: `blk_${String(blockSeq).padStart(16, '0')}`,
        type,
        enabled: true,
        content: dropEmptyFrames(merge(JSON.parse(JSON.stringify(BLOCK_DEFAULTS[type])), content)),
        style,
    };
}

const pageLink = (slug, anchor) => ({ kind: 'page', slug, ...(anchor ? { anchor } : {}) });
const appLink = (path) => ({ kind: 'app', path });
const extLink = (url) => ({ kind: 'external', url, newTab: true });

/* The licence answer appears on /pricing, /sovereignty and the Copilot
   Studio comparison. It used to be written out three times, in three
   slightly different forms - which is fine until the licence changes and
   only two of them get updated. One string, three questions. */
const LICENCE_ANSWER = 'Source-available, and we would rather be precise than borrow the word. '
    + 'The server and frontend are published under the Sustainable Use License v1.0: read it, '
    + 'modify it, run it internally without paying \u2014 what you may not do is resell Bee Flow as '
    + 'your own hosted service. It is not an OSI-approved open-source licence. We are working '
    + 'toward AGPL-3.0-or-later; today the Nextcloud connector is the only part that carries it.';

/* The connector-count objection, answered once.
   It is asked on every automation comparison, and the previous answers all
   opened with "No, and that is the clearest gap" — true, and it conceded the
   argument before making it. The two products are not counting the same
   thing: a catalogue is a list of what a vendor decided to build, and MCP is
   a socket you plug your own thing into. Say that first, then keep the
   concession, which is real and specific.

   `mcpAnswer(opening)` so each page opens in its own words — four identical
   paragraphs across four pages reads as boilerplate and is treated as such. */
const MCP_ANSWER = 'We ship 44 built-in integrations — Google Workspace, Microsoft 365, Nextcloud, '
    + 'ITSM, payroll — and then the ceiling comes off, because Bee Flow speaks the '
    + 'Model Context Protocol. Any MCP server becomes a set of tools your assistants and automations can '
    + 'call, over stdio or Streamable HTTP: the public ones, the ones your own vendors publish, and the one '
    + 'you write in an afternoon for the line-of-business system nobody has ever built a connector for. '
    + 'When you self-host, installing those is your decision and nobody has to add your system to a catalogue '
    + 'first — the install surface is an enterprise feature, and once a server is installed, using it is an '
    + 'ordinary integration with the same permissions and audit trail as the rest. '
    + 'Where a large catalogue genuinely wins is the long tail of SaaS you want working in ten minutes without '
    + 'writing anything, so check the specific apps you depend on before you switch.';
const mcpAnswer = (opening) => `${opening} ${MCP_ANSWER}`;

/**
 * A media slot. An EMPTY src is a first-class state, not an oversight: the
 * screenshots are supplied by the operator and may not exist yet, and
 * MediaText/Features/Steps all lay out text-only when `src` is blank. Never
 * invent an asset key to fill one.
 */
const media = (src, alt, frame = 'hairline') => ({ src: src || '', srcDark: '', alt, frame, kind: 'image' });

// ── Chrome ───────────────────────────────────────────────────────────

const header = {
    enabled: true,
    logoText: 'Bee Flow',
    logo: { src: KEYS.logo, text: 'Bee Flow', textColor: '', fontSize: 'medium', url: '/', showDot: false },
    loginLabel: '',
    ctaLabel: '',
    ctaLink: { kind: 'anchor', anchor: '' },
    ctas: [
        { id: 'cta_app', label: 'Open the app', link: appLink('/app'), style: 'primary' },
    ],
    // Mega menu on Product; plain items elsewhere. `dropdown.layout` must be
    // 'columns' — 'list' stores data that renders nothing.
    //
    // Mega-item icons are LUCIDE NAMES, same as block icons. They used to be
    // emoji, which meant the menu rendered in the visitor's OS emoji font —
    // three different visual languages across Mac, Windows and Android, none
    // of them ours, sitting next to a line-drawn product UI. NavIcon still
    // renders a non-PascalCase value verbatim, so sites seeded before the
    // change keep working; new items here should use a Lucide name.
    nav: [
        {
            id: 'nav_platform',
            label: 'Platform',
            link: pageLink('platform'),
            dropdown: {
                layout: 'columns',
                columns: [
                    {
                        id: 'navcol_build',
                        heading: 'Build',
                        items: [
                            { id: 'navi_platform', label: 'Platform overview', link: pageLink('platform'), description: 'Workflows, internal apps and agents — built three ways', icon: 'LayoutGrid' },
                            { id: 'navi_automations', label: 'Automations & automations', link: pageLink('automations'), description: 'Describe it, drag it, or let it suggest itself \u2014 playable here', icon: 'Workflow' },
                            { id: 'navi_assistants', label: 'Assistants', link: pageLink('assistants'), description: 'Build one by describing it \u2014 try the editor', icon: 'Bot' },
                            { id: 'navi_skills', label: 'Skills', link: pageLink('skills'), description: 'Write the guidance once, not in every assistant', icon: 'Sparkles' },
                            { id: 'navi_appstudio', label: 'App Studio', link: pageLink('app-studio'), description: 'Internal apps over their own database — try the editor', icon: 'AppWindow' },
                        ],
                    },
                    {
                        id: 'navcol_work',
                        heading: 'Work',
                        items: [
                            { id: 'navi_meeting_notes', label: 'Meeting notes', link: pageLink('meeting-notes'), description: 'Transcript, speakers, decisions and actions \u2014 try it here', icon: 'Mic' },
                            { id: 'navi_notebooks', label: 'Notebooks', link: pageLink('notebooks'), description: 'Draft from your sources, with citations', icon: 'NotebookPen' },
                            { id: 'navi_knowledge', label: 'Knowledge bases', link: pageLink('knowledge'), description: 'Cited answers from your own documents', icon: 'Library' },
                            { id: 'navi_support', label: 'Support inbox', link: pageLink('support'), description: 'A service desk that knows your documentation', icon: 'LifeBuoy' },
                            { id: 'navi_integrations', label: 'Integrations & MCP', link: pageLink('integrations'), description: 'Google Workspace, Microsoft 365 and any MCP server', icon: 'Plug' },
                        ],
                    },
                ],
            },
        },
        {
            id: 'nav_sovereignty',
            label: 'Sovereignty',
            link: pageLink('sovereignty'),
            dropdown: {
                layout: 'columns',
                columns: [
                    {
                        id: 'navcol_sov',
                        heading: 'Stay in control',
                        items: [
                            { id: 'navi_sovereignty', label: 'Data sovereignty', link: pageLink('sovereignty'), description: 'The four mechanisms, and how the result is measured', icon: 'Globe' },
                            { id: 'navi_shield', label: 'Privacy Shield', link: pageLink('privacy-shield'), description: 'See what actually reaches the model \u2014 live', icon: 'ShieldCheck' },
                            { id: 'navi_security', label: 'Security & encryption', link: pageLink('security'), description: 'Zero-knowledge keys, permissions and audit trails', icon: 'Lock' },
                            { id: 'navi_identity', label: 'Identity & access', link: pageLink('identity-access'), description: 'SSO, Entra ID group sync, roles and an access audit trail', icon: 'KeyRound' },
                            { id: 'navi_monitoring', label: 'Usage monitoring', link: pageLink('monitoring'), description: 'Which models, which people, what it cost', icon: 'BarChart3' },
                            { id: 'navi_compliance', label: 'Compliance Center', link: pageLink('compliance'), description: 'GDPR, the EU AI Act and ISO 27001, checked against your install', icon: 'ClipboardCheck' },
                        ],
                    },
                    {
                        id: 'navcol_run',
                        heading: 'Run it your way',
                        items: [
                            { id: 'navi_selfhost', label: 'Self-hosting', link: pageLink('self-hosting'), description: 'One command, Docker Compose or Kubernetes', icon: 'Server' },
                            { id: 'navi_editions', label: 'Community vs Enterprise', link: pageLink('editions'), description: 'What the free edition gives you, and what a key adds', icon: 'GitCompare' },
                            { id: 'navi_cloud', label: 'Managed EU cloud', link: pageLink('cloud'), description: 'We run it, in EU data centres', icon: 'Cloud' },
                        ],
                    },
                ],
            },
        },
        {
            id: 'nav_compare',
            label: 'Compare',
            link: pageLink('compare'),
            dropdown: {
                layout: 'columns',
                columns: [
                    {
                        id: 'navcol_cmp_ms',
                        heading: 'Microsoft',
                        items: [
                            // One item, deliberately. An "All comparisons" entry used to sit
                            // here for column balance and read as though the hub were a
                            // Microsoft page. The hub is reached by the Compare label itself
                            // — on mobile too, since MobileNav splits the row so the label
                            // navigates and only the caret expands — and it is the first
                            // link in the footer's Compare column. Padding a menu to make a
                            // column look even is how menus start lying about structure.
                            { id: 'navi_cmp_ms', label: 'vs Power Platform', link: pageLink('microsoft-alternative'), description: 'Copilot Studio, Power Automate and Power Apps in one answer', icon: 'Building2' },
                        ],
                    },
                    {
                        id: 'navcol_cmp_automation',
                        heading: 'Automation tools',
                        items: [
                            { id: 'navi_cmp_n8n', label: 'vs n8n', link: pageLink('n8n-alternative'), description: 'Both self-hostable — different assumptions', icon: 'Share2' },
                            { id: 'navi_cmp_zapier', label: 'vs Zapier', link: pageLink('zapier-alternative'), description: 'Flows that run where you decide', icon: 'Zap' },
                            { id: 'navi_cmp_make', label: 'vs Make', link: pageLink('make-alternative'), description: 'The visual canvas, on your infrastructure', icon: 'Puzzle' },
                        ],
                    },
                    {
                        id: 'navcol_cmp_ai',
                        heading: 'AI subscriptions',
                        items: [
                            { id: 'navi_cmp_chatgpt', label: 'vs ChatGPT Teams', link: pageLink('chatgpt-alternative'), description: 'Keep the model, change where it runs', icon: 'MessageSquare' },
                            { id: 'navi_cmp_gemini', label: 'vs Gemini for Workspace', link: pageLink('gemini-alternative'), description: 'Same Google apps, open model choice', icon: 'Sparkles' },
                            { id: 'navi_cmp_claude', label: 'vs Claude Team', link: pageLink('claude-alternative'), description: 'The same Claude, on your own stack', icon: 'Brain' },
                        ],
                    },
                    {
                        id: 'navcol_cmp_workspaces',
                        heading: 'AI workspaces',
                        items: [
                            { id: 'navi_cmp_langdock', label: 'vs Langdock', link: pageLink('langdock-alternative'), description: 'Both European — hosted, or self-hostable', icon: 'Building2' },
                            { id: 'navi_cmp_dust', label: 'vs Dust', link: pageLink('dust-alternative'), description: 'Hosted agents, or a workspace you hold', icon: 'Bot' },
                            { id: 'navi_cmp_openwebui', label: 'vs Open WebUI', link: pageLink('open-webui-alternative'), description: 'Same local models, more workspace around them', icon: 'TerminalSquare' },
                        ],
                    },
                ],
            },
        },
        { id: 'nav_pricing', label: 'Pricing', link: pageLink('pricing') },
        {
            id: 'nav_resources',
            label: 'Resources',
            link: pageLink('roadmap'),
            dropdown: {
                layout: 'columns',
                columns: [
                    {
                        id: 'navcol_res',
                        heading: 'More',
                        items: [
                            { id: 'navi_roadmap', label: 'Roadmap', link: pageLink('roadmap'), description: 'What is shipped, in beta, and still an idea', icon: 'Map' },
                            { id: 'navi_about', label: 'About', link: pageLink('about'), description: 'Who builds this', icon: 'Users' },
                            { id: 'navi_contact', label: 'Contact', link: pageLink('contact'), description: 'Talk to a human', icon: 'Mail' },
                            { id: 'navi_github', label: 'Source on GitHub', link: extLink('https://github.com/Bee-Flow/Bee-Flow'), description: 'Read it, fork it, run it', icon: 'Github' },
                        ],
                    },
                ],
            },
        },
    ],
};

const footer = {
    enabled: true,
    brandText: 'Bee Flow',
    blurb: 'A European AI automation workspace you can run yourself — workflows, internal apps and agents, built by chat or by hand. Made in the Netherlands, source-available, and auditable line by line.',
    columns: [
        // Six columns of five or six, not one of eleven beside one of three.
        //
        // "Product" used to hold every product page — eleven links — while
        // "Source" held three. A grid whose tallest column is nearly four
        // times its shortest reads as a dumping ground with some labels
        // sprinkled over it: the eye has nothing to scan, because "Product"
        // is not a category when it contains the entire site.
        //
        // The split mirrors the header exactly (Build / Work / Sovereignty /
        // Compare), so someone who used the menu already knows where to look.
        // "Open the app" is gone from here: it is the header CTA on every
        // page and closes every page as well, and a footer is for navigation,
        // not for a third copy of the primary action.
        {
            id: 'fcol_build',
            heading: 'Build',
            links: [
                { label: 'Platform', link: pageLink('platform') },
                { label: 'Automations & automations', link: pageLink('automations') },
                { label: 'Assistants', link: pageLink('assistants') },
                { label: 'Skills', link: pageLink('skills') },
                { label: 'App Studio', link: pageLink('app-studio') },
                { label: 'Integrations & MCP', link: pageLink('integrations') },
            ],
        },
        {
            id: 'fcol_work',
            heading: 'Work',
            links: [
                { label: 'Meeting notes', link: pageLink('meeting-notes') },
                { label: 'Notebooks', link: pageLink('notebooks') },
                { label: 'Knowledge bases', link: pageLink('knowledge') },
                { label: 'Support inbox', link: pageLink('support') },
            ],
        },
        {
            id: 'fcol_sovereignty',
            heading: 'Sovereignty',
            links: [
                { label: 'Data sovereignty', link: pageLink('sovereignty') },
                { label: 'Privacy Shield', link: pageLink('privacy-shield') },
                { label: 'Security & encryption', link: pageLink('security') },
                { label: 'Identity & access', link: pageLink('identity-access') },
                { label: 'Usage monitoring', link: pageLink('monitoring') },
                { label: 'Compliance Center', link: pageLink('compliance') },
                { label: 'Self-hosting', link: pageLink('self-hosting') },
                { label: 'Managed EU cloud', link: pageLink('cloud') },
            ],
        },
        {
            id: 'fcol_compare',
            heading: 'Compare',
            links: [
                { label: 'All comparisons', link: pageLink('compare') },
                { label: 'vs Power Platform', link: pageLink('microsoft-alternative') },
                { label: 'vs n8n', link: pageLink('n8n-alternative') },
                { label: 'vs Zapier', link: pageLink('zapier-alternative') },
                { label: 'vs Make', link: pageLink('make-alternative') },
                { label: 'vs ChatGPT Teams', link: pageLink('chatgpt-alternative') },
                { label: 'vs Langdock', link: pageLink('langdock-alternative') },
                { label: 'vs Open WebUI', link: pageLink('open-webui-alternative') },
            ],
        },
        {
            id: 'fcol_company',
            heading: 'Company',
            links: [
                { label: 'About', link: pageLink('about') },
                { label: 'Pricing', link: pageLink('pricing') },
                { label: 'Community vs Enterprise', link: pageLink('editions') },
                { label: 'Roadmap', link: pageLink('roadmap') },
                { label: 'Contact', link: pageLink('contact') },
                { label: 'Documentation', link: extLink('https://docs.beeflow.ai') },
                { label: 'Source on GitHub', link: extLink('https://github.com/Bee-Flow/Bee-Flow') },
                { label: 'Sustainable Use License', link: extLink('https://github.com/Bee-Flow/Bee-Flow/blob/main/LICENSE.md') },
            ],
        },
    ],
    socials: [
        { id: 'soc_github', platform: 'github', link: extLink('https://github.com/Bee-Flow/Bee-Flow') },
    ],
    copyright: '© Bee Flow B.V.',
    accountability: {
        address: 'Bovenkerkerweg 6 unit 1.12, 1185 XE Amstelveen, Netherlands',
        registration: 'KvK 97632430',
        vat: '',
        links: [
            // A reachable mailbox, not only a form: procurement questionnaires,
            // DPIA requests and security disclosures expect a direct address.
            { label: 'info@beeflow.nl', href: 'mailto:info@beeflow.nl' },
        ],
    },
    // Off until translated content actually exists: seven languages on offer
    // with zero pages translated is a dead control that erodes trust — the
    // switcher returns with the NL content round.
    showLanguageSwitcher: false,
    showBrandDot: false,
};

const announcement = {
    enabled: true,
    dismissible: true,
    variant: 'accent',
    text: {
        en: {
            message: 'A sovereign alternative to Copilot Studio and Power Automate — self-hostable, on the model you choose.',
            linkLabel: 'See how sovereignty works',
            linkUrl: '/sovereignty',
        },
        nl: { message: '', linkLabel: '', linkUrl: '' },
    },
};

const cookieBanner = {
    enabled: true,
    text: {
        en: {
            message: 'We use a cookieless, self-hosted analytics setup. We still ask, because consent is not a formality.',
            accept: 'Accept',
            decline: 'Decline',
            privacyLabel: 'Privacy policy',
            privacyUrl: '/privacy',
        },
        nl: {
            message: 'We gebruiken cookieloze, zelf-gehoste analytics. We vragen het toch, want toestemming is geen formaliteit.',
            accept: 'Accepteren',
            decline: 'Weigeren',
            privacyLabel: 'Privacybeleid',
            privacyUrl: '/privacy',
        },
    },
};

// european-warmth, materialised. Presets are applied by copying values, not
// by reference, so this is exactly what the Design tab would have written.
const design = {
    colors: {
        primary: '#F5A623', secondary: '#1F2937', accent: '#FFD166',
        background: '#FAF8F4', surface: '#F3EFE7',
        textPrimary: '#1C1917', textSecondary: '#57534E',
    },
    darkColors: {
        background: '#101012', surface: '#17171B',
        textPrimary: '#F4F2EE', textSecondary: '#A6A29A',
        primary: '', accent: '',
    },
    fonts: { heading: 'Fraunces', body: 'Inter', mono: 'IBM Plex Mono' },
    logo: KEYS.logo,
    favicon: KEYS.favicon,
    radius: 12,
    theme: 'light',
    gradient: false,
    preset: 'european-warmth',
    typography: { displaySize: 'lg', headingWeight: 600, bodySize: 17 },
    motion: 'subtle',
    grain: true,
    components: {
        buttonShape: 'soft', buttonSize: 'md',
        // #0B0B0C on #F5A623 is 10.1:1; white on the same amber is 2.03:1
        // and fails AA. Dark labels are not a style choice here.
        buttonTextColor: 'dark',
        navStyle: 'bar', navHeight: 'default', logoSize: 'md',
        cardStyle: 'hairline', cardPadding: 'default', shadow: 'soft',
    },
    layout: { containerWidth: 'default', sectionRhythm: 'default' },
};

// ── Pages ────────────────────────────────────────────────────────────

const home = {
    slug: 'home',
    title: 'Home',
    isHomepage: true,
    hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'The European, self-hostable AI workspace | Bee Flow',
        metaDescription: 'Build AI agents, automations and knowledge bases on your own servers or in the EU cloud — on the model you choose, with proof of where your data went.',
        ogImage: og('workspace'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: '',
            badge: { enabled: true, text: 'European · self-hostable · source-available', icon: 'ShieldCheck' },
            titleParts: [
                { text: 'Workflows, internal apps and AI agents — ', gradient: false },
                { text: 'on infrastructure you control', gradient: true },
            ],
            lead: 'A European, self-hostable alternative to Copilot Studio and Power Automate. Build by describing what you want, by dragging steps on a canvas, or by letting Bee Flow point at the work it can see you repeating — while every document, prompt and answer stays somewhere you chose.',
            primaryCta: { enabled: true, label: 'Open the app', style: 'primary', link: appLink('/app') },
            secondaryCta: { enabled: true, label: 'How sovereignty works', style: 'secondary', link: pageLink('sovereignty') },
            mockup: {
                enabled: true,
                chatBubbles: [
                    { role: 'user', text: 'What is our notice period for the Van Dijk contract?' },
                    { role: 'ai', text: 'Three months, ending on a calendar quarter — clause 7.2 of master-agreement.pdf. The clause also requires written notice.' },
                    { role: 'user', text: 'Draft the notice letter and put it in the client folder.' },
                ],
            },
            variant: 'panel',
            media: media(shot('chat') || KEYS.hive, 'A chat answering from your own documents', 'browser'),
            backgroundVariant: 'default',
        }),
        b('trust-band', {
            variant: 'chips',
            eyebrow: 'What that means in practice',
            chips: [
                { icon: 'ShieldCheck', label: 'Runs on your infrastructure', sublabel: 'Docker Compose or Kubernetes, in the region you pick', href: '' },
                { icon: 'Lock', label: 'Zero-knowledge encryption', sublabel: 'Chat and notebooks, under a key only you hold. No support backdoor.', href: '' },
                { icon: 'Scale', label: 'Fair-code licensed', sublabel: 'Source available and auditable, not a black box', href: '' },
                { icon: 'Server', label: 'Bring your own model', sublabel: 'Six cloud providers, or a local model that never phones home', href: '' },
                { icon: 'KeyRound', label: 'SSO with directory sync', sublabel: 'Google, Microsoft Entra ID and Nextcloud — groups follow your IdP', href: '/identity-access' },
            ],
        }),
        b('features', {
            eyebrow: 'The workspace',
            title: 'Everything a team needs from AI, without shipping your data to it',
            lead: '',
            variant: 'bento',
            items: [
                {
                    icon: 'Bot', span: 2,
                    title: 'Assistants that know your business',
                    body: 'Build an assistant per team or per task — no code. Give it instructions, knowledge, tools and memory, then share it. Eleven assistants ship pre-built, from meeting summarisers to a prompt designer.',
                    techTag: 'Agents · Skills · Memory',
                    media: media(shot('agent-editor'), 'The assistant editor', 'hairline'),
                },
                {
                    icon: 'Library', span: 1,
                    title: 'Answers with receipts',
                    body: 'Point a knowledge base at PDFs, Office files, email or a Nextcloud folder. Answers arrive with numbered citations, so a reader can check the source instead of trusting the model.',
                    techTag: 'pgvector + BM25',
                    media: media('', ''),
                },
                {
                    icon: 'Workflow', span: 1,
                    title: 'Automations that do the follow-up',
                    body: 'Twenty-four step types, triggered on a schedule, a webhook or an event in a connected app. Approval gates and dry runs included, because unattended AI needs brakes.',
                    techTag: '27 step types',
                    media: media(shot('automation-canvas'), 'The automation builder', 'hairline'),
                },
                {
                    icon: 'Mic', span: 1,
                    title: 'Meetings that write themselves up',
                    body: 'Transcription with speaker diarisation, summaries, decisions and action items. Choose a cloud engine or run WhisperX on your own GPU.',
                    techTag: '7 engines',
                    media: media('', ''),
                },
                {
                    icon: 'Plug', span: 1,
                    title: 'Connected to the tools you have',
                    body: '44 built-in integrations covering Google Workspace, Microsoft 365 and Nextcloud — plus any Model Context Protocol server you want to add.',
                    techTag: 'plus any MCP server',
                    media: media('', ''),
                },
                {
                    icon: 'ShieldCheck', span: 2,
                    title: 'A privacy layer that is switched on by default',
                    body: 'Install the detector and prompts are scanned for personal data on your own hardware before they leave. Block it, mask it, ask the user, or swap real values for placeholders and restore them in the answer. If the detector is installed but unreachable, the request is blocked rather than sent unchecked — it fails closed, not quietly open.',
                    techTag: '21 PII categories',
                    media: media('', ''),
                },
            ],
        }),
        b('showcase', {
            variant: 'code-ui',
            eyebrow: 'Install',
            title: 'From nothing to a running workspace',
            lead: 'One script pulls the public images, generates your secrets and prints the URL and the admin password. No licence key, no account, no phone-home.',
            media: media(KEYS.architecture, 'Bee Flow service architecture', 'browser'),
            code: {
                language: 'bash',
                snippet: 'git clone https://github.com/Bee-Flow/Bee-Flow\ncd Bee-Flow\n./selfhost.sh\n\n# add optional services when you need them\nPROFILES="core search guard" ./selfhost.sh',
            },
        }),
        b('steps', {
            eyebrow: 'Getting started',
            title: 'Useful on day one, not after a consulting engagement',
            variant: 'chapters',
            items: [
                {
                    number: '1', title: 'Stand it up', example: '',
                    body: 'Run the self-host script, install the Nextcloud app, or use the hosted version at beeflow.nl. All three are the same codebase — you can move between them later.',
                    media: media('', ''),
                },
                {
                    number: '2', title: 'Bring your knowledge', example: '',
                    body: 'Upload documents, crawl a site, or connect a Nextcloud folder. Extraction, chunking and embedding run in-process on CPU if you have not configured a provider — nothing external is required to get useful answers.',
                    media: media(KEYS.knowledgeFlow, 'From documents to a cited answer', 'hairline'),
                },
                {
                    number: '3', title: 'Roll it out', example: '',
                    body: 'Invite the team, assign assistants to groups, and set the privacy rules once at organisation level. Users get the shield whether or not they think about it.',
                    media: media('', ''),
                },
            ],
        }),
        b('techStats', {
            eyebrow: 'By the numbers',
            title: 'What ships in the box',
            stats: [
                { number: '44', label: 'built-in integrations' },
                { number: 'any', label: 'MCP server, on stdio or Streamable HTTP' },
                { number: '21', label: 'categories of personal data detected' },
                { number: '6', label: 'LLM providers, plus any local model' },
            ],
        }, { band: 'surface' }),
        // Social proof, the verifiable kind: live repository facts fetched at
        // view time rather than a number typed here that goes stale. The rule
        // at the top of this file — no invented logos, no invented counts —
        // is exactly why this block exists instead of a testimonial wall.
        b('github-stats', {
            eyebrow: 'In the open',
            title: 'The claim you can check yourself',
            lead: 'Stars, releases and the code behind every privacy claim on this site — read it before you trust it.',
            repoUrl: 'https://github.com/Bee-Flow/Bee-Flow',
            linkLabel: 'Bee-Flow/Bee-Flow on GitHub',
        }),
        b('faq', {
            eyebrow: 'FAQ',
            title: 'The questions we actually get asked',
            items: [
                {
                    question: 'Is the free version crippled?',
                    answer: 'No. The Community tier needs no licence key and has no cap on users, assistants, messages or knowledge sources. Chat, knowledge bases, skills, integrations, automations and the learning centre are all included. Paid tiers add specific modules — meeting notes, the app builder, the compliance hub — not permission to keep using what you already had.',
                },
                {
                    question: 'Do my prompts train someone else\'s model?',
                    answer: 'Bee Flow never trains on your data. What happens at the model provider is governed by that provider\'s terms, not by us — which is exactly why the platform supports local models through any OpenAI-compatible endpoint. Point it at Ollama, vLLM or llama.cpp and nothing leaves your network at all.',
                },
                {
                    question: 'What if the AI is about to send something sensitive?',
                    answer: 'Once installed, Privacy Shield inspects outbound prompts before they leave, using a detector that runs on your own hardware. You choose what happens per organisation: block, mask, ask the user first, or substitute placeholders and restore the real values in the answer you read.',
                },
                {
                    question: 'Can we leave?',
                    answer: 'The source is available under a fair-code licence, the data sits in your own PostgreSQL, and a whole website, knowledge base or automation exports to an open format in one click. Leaving is a decision, not a project.',
                },
            ],
        }),
        b('cta', {
            title: 'Try it on your own hardware first',
            lead: 'The fastest way to evaluate a privacy claim is to run the thing yourself and watch the network.',
            button: { label: 'Self-hosting guide', link: pageLink('self-hosting') },
            secondaryCta: { label: 'Talk to us', link: pageLink('contact') },
            showMotif: true,
            backgroundVariant: 'dark',
        }),
    ],
};

const platform = {
    slug: 'platform',
    title: 'Platform',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'AI agents, automations and apps in one platform | Bee Flow',
        metaDescription: 'Workflows, internal apps and AI agents sharing one permission model, one audit trail and one privacy layer. Self-hostable, on the model you choose.',
        ogImage: og('workspace'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Platform',
            badge: { enabled: false, text: '', icon: '' },
            titleParts: [{ text: 'One place to build it, not a shelf of AI subscriptions', gradient: false }],
            lead: 'Workflows, internal apps, AI agents, knowledge, meeting notes and a support desk — sharing one permission model, one audit trail and one privacy layer. Build any of it by describing what you want, by dragging it together, or by letting Bee Flow propose it from work it can see you repeating.',
            primaryCta: { enabled: true, label: 'Open the app', style: 'primary', link: appLink('/app') },
            secondaryCta: { enabled: true, label: 'How sovereignty works', style: 'secondary', link: pageLink('sovereignty') },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'split',
            media: media(KEYS.architecture, 'Bee Flow service architecture', 'browser'),
        }),
        b('features', {
            eyebrow: 'Studio',
            title: 'Ten places to build something',
            lead: 'Everything below lives behind one navigation, so a person who learns the chat window can find the rest.',
            variant: 'bento',
            items: [
                { icon: 'Bot', span: 1, title: 'Agents', body: 'No-code assistants with instructions, tools, knowledge and memory. Share them per group.', techTag: '', media: media('', '') },
                { icon: 'Sparkles', span: 1, title: 'Skills', body: 'Reusable instruction packs an assistant pulls in when the task calls for it.', techTag: '', media: media('', '') },
                { icon: 'Library', span: 2, title: 'Knowledge', body: 'Hybrid retrieval over your own documents — vector search and keyword search fused, then reranked by a cross-encoder. Local Postgres or a dedicated search service.', techTag: 'pgvector · BM25 · RRF', media: media('', '') },
                { icon: 'Workflow', span: 2, title: 'Automations & automations', body: 'Scheduled agent runs and full workflows: conditions, loops, parallel branches, sandboxed code, HTTP calls, approval gates and dry runs. Import an existing n8n workflow and convert it.', techTag: '27 step types', media: media('', '') },
                { icon: 'Mic', span: 1, title: 'Meeting notes', body: 'Transcription, speaker diarisation, summaries, decisions and action items.', techTag: '', media: media('', '') },
                { icon: 'AppWindow', span: 1, title: 'App Studio', body: 'Internal apps with forms, data and permissions — built by describing them.', techTag: '', media: media('', '') },
                { icon: 'Globe', span: 1, title: 'Webpages', body: 'Full-stack pages with their own database, published from the workspace.', techTag: '', media: media('', '') },
                { icon: 'LifeBuoy', span: 1, title: 'Support inbox', body: 'AI-first ticket handling with SLA policies you configure and auto-assignment.', techTag: '', media: media('', '') },
            ],
        }),
        b('media-text', {
            heading: 'Assistants that remember, and know where to look',
            subheading: 'Agents · Skills · Memory · Projects',
            body: 'An assistant is instructions plus context. Bee Flow gives it long-term memory scoped to the user or the project, skills it can pull in on demand, and tools it can call across your connected apps — and any MCP server you point it at. Eleven assistants ship ready to use, including a meeting summariser and a system-prompt designer, so the first useful result does not wait for a prompt-engineering workshop.',
            cta: { label: 'See what they can call', link: pageLink('integrations') },
            media: { kind: 'image', src: shot('agent-editor'), alt: 'The assistant editor', srcDark: '', frame: 'hairline' },
            mediaPosition: 'right',
            mediaSize: 'half',
            backgroundVariant: 'default',
        }),
        b('media-text', {
            heading: 'Retrieval you can argue with',
            subheading: 'Knowledge bases',
            body: 'Documents are extracted, chunked with a token budget and de-duplicated before they are ever embedded. At query time, vector search and BM25 keyword search run side by side and are fused, then a cross-encoder reranks what survives. Answers cite numbered sources. If you have not configured an embedding provider, both the embedder and the reranker fall back to models that run in-process on CPU — so a laptop install still retrieves properly.',
            cta: null,
            media: { kind: 'image', src: KEYS.knowledgeFlow, alt: 'From documents to a cited answer', srcDark: '', frame: 'hairline' },
            mediaPosition: 'left',
            mediaSize: 'two-thirds',
            backgroundVariant: 'surface',
        }),
        b('feature-demo', {
            eyebrow: 'Live demo',
            title: 'The knowledge layer, as an admin sees it',
            lead: 'Knowledge bases are the substrate the assistants read from: grouped by category, scoped per group, and counted so you can see what retrieval is actually working with. Seven sample bases here — a handbook, product documentation, a tender answer library.',
            feature: 'knowledge',
            height: 680,
            theme: 'light',
            note: 'Sample knowledge bases. No documents are included and nothing is uploaded — the demo has no network access.',
        }),
        b('media-text', {
            heading: 'Automation with a brake pedal',
            subheading: 'Automations & automations',
            body: 'Workflows trigger on a schedule, an inbound webhook, a manual run, or one of thirteen events in your connected apps — new mail, a changed file, an upcoming meeting. Steps include conditions, loops, parallel branches, filters, aggregation, HTTP requests and code that runs in an isolated sandbox behind an SSRF guard. Approval steps pause the run for a human, dry runs show you what would happen, and every run keeps a step-by-step log with sensitive values redacted.',
            cta: { label: 'Try the builder', link: pageLink('automations') },
            media: { kind: 'image', src: shot('automation-canvas'), alt: 'The automation builder', srcDark: '', frame: 'browser' },
            mediaPosition: 'right',
            mediaSize: 'half',
            backgroundVariant: 'default',
        }),
        b('media-text', {
            heading: 'One permission model — what those four words mean',
            subheading: 'Identity & access',
            body: 'Everything above shares a single rights model, and it only ever grants: the licence sets a ceiling, the operator chooses what is available, an organisation admin grants from that, and groups grant on top — synced from Microsoft Entra ID, or mirrored live from Nextcloud. Assistants, knowledge bases, skills and apps are shared with the organisation or with specific groups; App Studio apps add row-level access rules inside the app. Every access change lands in an audit log built for GDPR Article 30 evidence, so "who could see this, and since when" is a query, not an archaeology project.',
            cta: { label: 'Identity & access, in full', link: pageLink('identity-access') },
            media: { kind: 'image', src: '', alt: '', srcDark: '', frame: '' },
            mediaPosition: 'left',
            mediaSize: 'half',
            backgroundVariant: 'surface',
        }),
        b('architecture', {
            eyebrow: 'Under the hood',
            title: 'Four layers, all of them yours',
            lead: 'Nothing in this diagram is a hosted dependency. The optional Python services are separate images you enable per profile.',
            layers: [
                { label: 'Agent Hub — React 19 SPA', tags: ['Chat', 'Studio', 'Admin', 'Product website'] },
                { label: 'Server — Node 22 / Express 5', tags: ['Agent runtime', 'Automations', 'RAG', 'MCP', 'Licensing', 'CMS'] },
                { label: 'Optional services', tags: ['Guard (PII)', 'Search', 'Reranker', 'WhisperX', 'Headless browser'] },
                { label: 'Data', tags: ['PostgreSQL + pgvector', 'S3-compatible storage', 'Redis'] },
            ],
        }),
        b('showcase', {
            variant: 'single',
            eyebrow: '',
            title: 'The topology you deploy',
            lead: '',
            media: media(KEYS.architecture, 'Bee Flow service architecture', 'browser'),
        }, { band: 'surface' }),
        b('cta-banner', {
            heading: 'Have a look at the parts you care about',
            subheading: 'The security model and the deployment story are the two things most teams check first.',
            layout: 'split',
            backgroundVariant: 'primary',
            primaryCta: { label: 'Security & privacy', link: pageLink('security') },
            secondaryCta: { label: 'Self-hosting', link: pageLink('self-hosting') },
        }),
    ],
};

const security = {
    slug: 'security',
    title: 'Security',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'Security — zero-knowledge encryption, SSO, MFA | Bee Flow',
        metaDescription: 'AES-256-GCM under an Argon2id key, OPAQUE login (RFC 9807), SSO with MFA, leak-resistant audit logs and compliance checks that read your live install.',
        ogImage: og('security'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Security & privacy',
            badge: { enabled: false, text: '', icon: '' },
            titleParts: [{ text: 'Privacy that is enforced, not promised', gradient: false }],
            lead: 'The interesting question is not whether a vendor says your data is safe. It is what the code does when nobody is looking — which parameters, which algorithms, which failure modes. This page is the detail; the source is one click further.',
            primaryCta: { enabled: true, label: 'Read the privacy policy', style: 'primary', link: appLink('/privacy') },
            secondaryCta: { enabled: false, label: '', style: 'secondary', link: '' },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'classic',
            media: media('', ''),
        }),
        b('security', {
            eyebrow: 'The controls',
            title: 'Four layers, and what each one actually does',
            lead: '',
            variant: 'ledger',
            cards: [
                {
                    icon: 'Lock',
                    title: 'Zero-knowledge encryption',
                    summary: 'Your data is encrypted under a key the server cannot derive on its own.',
                    details: [
                        'A random 256-bit data key per user, wrapped by a key derived from the password with Argon2id (128 MB memory, 4 iterations, 4 lanes)',
                        'AES-256-GCM with 12-byte IVs and context binding, per NIST SP 800-38D',
                        'No master key and no backdoor — losing both password and recovery key means the data is gone, by design',
                        'Accounts can be migrated to OPAQUE (RFC 9807), where the password is verified without the server ever receiving it; the default path is bcrypt over TLS',
                    ],
                    link: { label: '', href: '' },
                },
                {
                    icon: 'KeyRound',
                    title: 'Credentials, sealed separately',
                    summary: 'Connector secrets do not live in the same blast radius as user data.',
                    details: [
                        'A per-organisation secret vault holds OAuth tokens and API keys under its own derived key, not the user data key',
                        'Secrets are never returned to the browser — the server substitutes them at call time and the UI only ever sees whether one is set',
                        'Rotating a vault key re-wraps in place; no plaintext round trip through an admin screen',
                        'Outbound calls resolve through an SSRF guard, so a connector cannot be pointed at your internal network',
                        'Custom and MCP integrations inherit the same vault and the same guard as the built-in ones',
                    ],
                    link: { label: '', href: '' },
                },
                {
                    icon: 'ScrollText',
                    title: 'Audit that does not become a second leak',
                    summary: 'Enough evidence to investigate an incident, without copying the sensitive text into a log.',
                    details: [
                        'Guardrail events record the category, direction and action taken — never the matched content',
                        'Automation runs keep per-step logs with sensitive values redacted',
                        'Unusual decryption volume raises an alert — 50 decryptions a minute is treated as possible bulk extraction',
                        'Outbound webhooks are HMAC-signed so a receiving SIEM can verify them',
                        'Every integration endpoint is resolved to a country at log time, flagging non-EEA transfers',
                    ],
                    link: { label: '', href: '' },
                },
                {
                    icon: 'Scale',
                    title: 'Compliance you can evidence',
                    summary: 'A running check suite, not a PDF of intentions.',
                    details: [
                        '15 automated GDPR checks covering Articles 5, 12, 15, 17, 28, 30, 32, 33, 35, 37 and 44',
                        '6 EU AI Act checks covering AI literacy, transparency, human oversight, log retention, disclosure and the model inventory',
                        'Data-subject request intake stays reachable by design — it is never gated behind a licence',
                        'Records of processing and DPIA registers live in the product, next to the systems they describe',
                        'Voice profiles are treated as Article 9 biometric data: separate consent, no read API at any privilege level, deleted on withdrawal',
                    ],
                    link: { label: '', href: '' },
                },
                {
                    icon: 'KeyRound',
                    title: 'Identity, brought in from your IdP',
                    summary: 'Sign-in and group membership come from the directory you already run.',
                    details: [
                        'OAuth SSO with Google, Microsoft Entra ID (single- and multi-tenant) and Nextcloud',
                        'Entra ID group sync on an optional schedule, re-checked when someone signs in; Nextcloud users and groups mirrored via webhooks',
                        'TOTP two-factor with hashed recovery codes; accounts on the OPAQUE path keep the password itself off the server',
                        'Six built-in organisation roles — including DPO and ISMS auditor — plus custom roles from granular permissions',
                        'Access changes land in a dedicated audit log, built for Article 30 evidence',
                    ],
                    link: { label: 'Identity & access', href: '/identity-access' },
                },
            ],
        }),
        b('media-text', {
            heading: 'Two things this page deliberately does not cover',
            subheading: 'Where to read further',
            body: 'Outbound data-loss prevention has its own page, because the interesting part is what the detector does to a prompt rather than how it is configured — see Privacy Shield for the tokenise-and-restore walkthrough. Where your data physically sits, which model provider sees it, and how that is measured has its own page too. Both are linked below rather than summarised here, so there is one place per subject that stays correct.',
            cta: { label: 'How sovereignty works', link: pageLink('sovereignty') },
            media: { kind: 'image', src: shot('shield-redaction') || KEYS.privacyFlow, alt: 'How Privacy Shield handles an outbound prompt', srcDark: '', frame: 'hairline' },
            mediaPosition: 'left',
            mediaSize: 'two-thirds',
            backgroundVariant: 'surface',
        }),
        b('trust-band', {
            variant: 'detailed',
            eyebrow: 'Where things stand',
            title: 'Honest about the boundaries',
            chips: [
                { icon: 'KeyRound', label: 'SSO with MFA and Entra ID group sync', sublabel: 'OAuth with Google, Microsoft Entra ID and Nextcloud, groups synced from your directory, TOTP as the second factor. No SAML and no SCIM — the identity page says exactly where that line is.', href: '/identity-access' },
                { icon: 'ServerCog', label: 'TLS terminates at your proxy', sublabel: 'Encryption in transit is handled by the reverse proxy you run in front — Caddy, nginx, Traefik. Bee Flow does not manage certificates for you.', href: '' },
                { icon: 'FileWarning', label: 'No third-party penetration test yet', sublabel: 'The code is open to read and the checks run against your live configuration, but we have not commissioned an external audit. We would rather say so than imply one.', href: '' },
            ],
        }),
        b('techStats', {
            eyebrow: '',
            title: 'The security posture in numbers',
            stats: [
                { number: '128 MB', label: 'Argon2id memory cost per key derivation' },
                { number: '21', label: 'PII categories detected on-premise' },
                { number: '44', label: 'automated GDPR, EU AI Act and ISO 27001 checks' },
                { number: '0', label: 'master keys that could decrypt your data' },
            ],
        }, { band: 'dark' }),
        b('faq', {
            eyebrow: 'FAQ',
            title: 'Security questions worth a straight answer',
            items: [
                {
                    question: 'Can Bee Flow staff read our documents?',
                    answer: 'On a self-hosted install there is no Bee Flow staff involved — you hold the infrastructure. On the hosted version, your chat and notebook conversations are encrypted under a key derived from your own password with Argon2id, and there is no support backdoor that would let us unwrap them. Knowledge-base documents and meeting transcripts are stored server-readable, because search and diarisation have to read them — we would rather name the boundary than let the strongest claim cover everything.',
                },
                {
                    question: 'What happens when someone forgets their password?',
                    answer: 'They use their recovery key, which wraps the same data key independently. Without either one the encrypted data cannot be recovered — that is the direct consequence of there being no backdoor, and it is worth telling your users before they need it.',
                },
                {
                    question: 'Does the PII detection send our text to a third party?',
                    answer: 'No. Detection runs in a container on your own hardware using an Apache-2.0 licensed model on CPU — 21 categories, with the Dutch BSN validated by its checksum rather than guessed. An external detection service can be configured if you want one, but nothing on the default path leaves your network. If you install the detector and it later becomes unreachable, the request fails closed rather than being sent unchecked. Privacy Shield has the full walkthrough.',
                },
                {
                    question: 'How do we prove any of this to an auditor?',
                    answer: 'The compliance hub runs 15 GDPR checks and 6 EU AI Act checks against the live configuration and shows what passes, what fails and why. Combined with the guardrail event log and the automation run history, that is an evidence trail rather than a policy statement.',
                },
            ],
        }),
        b('cta', {
            title: 'Do not take the security page on trust',
            lead: 'Run it yourself and watch the network, or read the encryption and DLP code directly. Both are faster than a vendor questionnaire.',
            button: { label: 'Self-hosting guide', link: pageLink('self-hosting') },
            secondaryCta: { label: 'See the shield working', link: pageLink('privacy-shield') },
            showMotif: true,
            backgroundVariant: 'dark',
        }),
    ],
};

const integrations = {
    slug: 'integrations',
    title: 'Integrations',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: '44 integrations plus any MCP server | Bee Flow',
        metaDescription: 'Google Workspace, Microsoft 365, Nextcloud, ITSM and payroll built in — plus any Model Context Protocol server, over stdio or Streamable HTTP.',
        ogImage: og('feature'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Integrations',
            badge: { enabled: true, text: '44 built in · any MCP server', icon: 'Plug' },
            titleParts: [{ text: 'Connected to the tools you already pay for', gradient: false }],
            lead: 'Assistants and automations act inside your existing systems: read the thread, file the document, book the slot, update the ticket. Forty-four connectors ship built in — and because Bee Flow is a Model Context Protocol client, anything with an MCP server connects too. Nothing has to be migrated first.',
            primaryCta: { enabled: true, label: 'Open the app', style: 'primary', link: appLink('/app') },
            secondaryCta: { enabled: false, label: '', style: 'secondary', link: { kind: 'anchor', anchor: '' } },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'classic',
            media: media('', ''),
        }),
        b('integrations', {
            eyebrow: '',
            title: 'What connects today',
            lead: 'Every item below is a shipped integration with real tools behind it, gated per user, per organisation and per group.',
            categories: [
                {
                    heading: 'Google Workspace',
                    items: [
                        { icon: 'Mail', label: 'Gmail', logoId: 'gmail', logoSrc: '' },
                        { icon: 'Calendar', label: 'Calendar', logoId: 'google_calendar', logoSrc: '' },
                        { icon: 'HardDrive', label: 'Drive', logoId: 'google_drive', logoSrc: '' },
                        { icon: 'FileText', label: 'Docs', logoId: 'google_docs', logoSrc: '' },
                        { icon: 'Table', label: 'Sheets', logoId: 'google_sheets', logoSrc: '' },
                        { icon: 'Presentation', label: 'Slides', logoId: 'google_slides', logoSrc: '' },
                        { icon: 'Users', label: 'Contacts', logoId: 'google_contacts', logoSrc: '' },
                        { icon: 'Users', label: 'Groups', logoId: 'google_groups', logoSrc: '' },
                        { icon: 'NotebookPen', label: 'Keep', logoId: 'google_keep', logoSrc: '' },
                        { icon: 'MapPin', label: 'Maps', logoId: 'google_maps', logoSrc: '' },
                        { icon: 'Video', label: 'Meet recordings', logoId: 'google_meet', logoSrc: '' },
                    ],
                },
                {
                    heading: 'Microsoft 365',
                    items: [
                        { icon: 'Mail', label: 'Outlook', logoId: 'outlook', logoSrc: '' },
                        { icon: 'Calendar', label: 'Calendar', logoId: 'ms_calendar', logoSrc: '' },
                        { icon: 'Users', label: 'Contacts', logoId: 'ms_contacts', logoSrc: '' },
                        { icon: 'HardDrive', label: 'OneDrive', logoId: 'onedrive', logoSrc: '' },
                        { icon: 'KeyRound', label: 'Entra ID SSO & group sync', logoId: 'entra_id', logoSrc: '' },
                    ],
                },
                {
                    heading: 'Nextcloud',
                    items: [
                        { icon: 'Folder', label: 'Files', logoId: 'nextcloud', logoSrc: '' },
                        { icon: 'Mail', label: 'Mail', logoId: 'nextcloud_mail', logoSrc: '' },
                        { icon: 'Calendar', label: 'Calendar', logoId: 'nextcloud_calendar', logoSrc: '' },
                        { icon: 'Users', label: 'Contacts', logoId: 'nextcloud_contacts', logoSrc: '' },
                        { icon: 'Kanban', label: 'Deck', logoId: 'nextcloud_deck', logoSrc: '' },
                        { icon: 'MessageSquare', label: 'Talk', logoId: 'nextcloud_talk', logoSrc: '' },
                        { icon: 'NotebookPen', label: 'Notes', logoId: 'nextcloud_notes', logoSrc: '' },
                        { icon: 'CheckSquare', label: 'Tasks', logoId: 'nextcloud_tasks', logoSrc: '' },
                        { icon: 'Bell', label: 'Activity & Notifications', logoId: 'nextcloud_notifications', logoSrc: '' },
                    ],
                },
                {
                    heading: 'Service management',
                    items: [
                        { icon: 'Ticket', label: 'Jira', logoId: 'jira', logoSrc: '' },
                        { icon: 'Ticket', label: 'ServiceNow', logoId: 'servicenow', logoSrc: '' },
                        { icon: 'Ticket', label: 'Zendesk', logoId: 'zendesk', logoSrc: '' },
                        { icon: 'Ticket', label: 'Freshservice', logoId: 'freshservice', logoSrc: '' },
                        { icon: 'Ticket', label: 'TopDesk', logoId: 'topdesk', logoSrc: '' },
                    ],
                },
                {
                    heading: 'Development',
                    items: [
                        { icon: 'Github', label: 'GitHub', logoId: 'github', logoSrc: '' },
                        { icon: 'Bug', label: 'YouTrack', logoId: 'youtrack', logoSrc: '' },
                        { icon: 'Workflow', label: 'n8n', logoId: 'n8n', logoSrc: '' },
                        { icon: 'TestTube', label: 'Playwright test runs', logoId: 'playwright', logoSrc: '' },
                    ],
                },
                {
                    heading: 'Business & back office',
                    items: [
                        { icon: 'Building2', label: 'AFAS Profit (read-only)', logoId: 'afas_profit', logoSrc: '' },
                        { icon: 'Users', label: 'NMBRS payroll (read-only)', logoId: 'nmbrs', logoSrc: '' },
                        { icon: 'PenTool', label: 'SignRequest', logoId: 'signrequest', logoSrc: '' },
                        { icon: 'CreditCard', label: 'Stripe billing', logoId: 'stripe', logoSrc: '' },
                        { icon: 'Presentation', label: 'Gamma', logoId: 'gamma', logoSrc: '' },
                        { icon: 'Linkedin', label: 'LinkedIn posting', logoId: 'linkedin', logoSrc: '' },
                    ],
                },
                {
                    heading: 'Search, voice & media',
                    items: [
                        { icon: 'Search', label: 'Web search', logoId: 'web_search', logoSrc: '' },
                        { icon: 'Globe', label: 'Browse a page for real', logoId: 'webpages', logoSrc: '' },
                        { icon: 'Mic', label: 'Speech to text', logoId: 'transcription', logoSrc: '' },
                        { icon: 'AudioLines', label: 'ElevenLabs voice', logoId: 'elevenlabs', logoSrc: '' },
                        { icon: 'Image', label: 'Image & video generation', logoId: 'image_gen', logoSrc: '' },
                        { icon: 'FileAudio', label: 'Fireflies transcripts', logoId: 'fireflies', logoSrc: '' },
                    ],
                },
            ],
        }),
        b('media-text', {
            heading: 'The other several thousand',
            subheading: 'Model Context Protocol',
            body: 'The list above is what we maintain. It is not the limit. Bee Flow is a Model Context Protocol client over stdio and Streamable HTTP, which means any MCP server — the official registry, a vendor\'s own, or one your team wrote this afternoon — installs and becomes an ordinary integration. Its tools appear alongside the built-in ones, obey the same per-group permissions, and pass through the same redaction layer. Browse the registry from inside the admin, start from a curated catalogue of 89 servers (GitHub, Slack, Notion, Linear, Postgres, Figma), or have an assistant build you a custom REST or remote-MCP connector behind the same SSRF guard as everything else.',
            cta: { label: 'See the platform', link: pageLink('platform') },
            media: { kind: 'image', src: shot('integrations'), alt: 'The integrations and MCP list', srcDark: '', frame: 'hairline' },
            mediaPosition: 'right',
            mediaSize: 'half',
            backgroundVariant: 'surface',
        }),
        b('steps', {
            eyebrow: 'Control',
            title: 'Connected is not the same as unrestricted',
            variant: 'chapters',
            items: [
                {
                    number: '1', title: 'A person connects their own account', example: 'OAuth, on their own credentials',
                    body: 'Nothing is connected org-wide by default. An integration acts as the person who authorised it, so an assistant can never read a mailbox its user could not open themselves.',
                    media: media('', ''),
                },
                {
                    number: '2', title: 'Three gates have to agree', example: 'user enabled it, org allows it, group has not switched it off',
                    body: 'A tool appears only when all three say yes. Group-level rules use enable-wins semantics, so a deliberate grant is never silently overridden by a broader default.',
                    media: media('', ''),
                },
                {
                    number: '3', title: 'What comes back is scanned too', example: '',
                    body: 'Data returned by a tool passes the same redaction layer as anything you type, and the endpoint it came from is resolved to a country at log time - so a transfer outside the EEA is visible rather than assumed.',
                    media: media('', ''),
                },
            ],
        }),
        b('cta', {
            title: 'Missing something you need?',
            lead: 'If it has an API or an MCP server, it can be connected — by you, without waiting for us. If you would rather we did it, say what you are trying to reach.',
            button: { label: 'Get in touch', link: pageLink('contact') },
            secondaryCta: { label: 'Run it yourself', link: pageLink('self-hosting') },
            showMotif: true,
            backgroundVariant: 'dark',
        }),
    ],
};

const selfHosting = {
    slug: 'self-hosting',
    title: 'Self-hosting',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'Self-host an AI workspace — Docker or Kubernetes | Bee Flow',
        metaDescription: 'One command brings up the whole workspace: public images, compose profiles, Kubernetes docs and offline licence checks for air-gapped installs.',
        ogImage: og('feature'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Self-hosting',
            badge: { enabled: true, text: 'No licence key required', icon: 'Server' },
            titleParts: [
                { text: 'Your servers, your region, ', gradient: false },
                { text: 'your keys', gradient: true },
            ],
            lead: 'Bee Flow was built to be run by the people who use it. The images are public, the install is one command, and nothing calls home for permission to start.',
            primaryCta: { enabled: true, label: 'Source on GitHub', style: 'primary', link: extLink('https://github.com/Bee-Flow/Bee-Flow') },
            secondaryCta: { enabled: true, label: 'What it costs', style: 'secondary', link: pageLink('pricing') },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'split',
            media: media(KEYS.architecture, 'Bee Flow service architecture', 'browser'),
        }),
        b('showcase', {
            variant: 'code-ui',
            eyebrow: 'The short version',
            title: 'One script, then a URL and a password',
            lead: 'The script pulls the public images, generates secrets, waits for the health check and prints where to go. Optional services are opt-in profiles, so a small install stays small.',
            media: media(KEYS.hive, '', 'browser'),
            code: {
                language: 'bash',
                snippet: '# core stack: server, frontend, PostgreSQL, object storage\n./selfhost.sh\n\n# add web search and the privacy guard\nPROFILES="core search guard" ./selfhost.sh\n\n# day-to-day\n./selfhost.sh --status\n./selfhost.sh --logs\n./selfhost.sh --stop',
            },
        }),
        b('steps', {
            eyebrow: 'Pick your install',
            title: 'Six supported ways in',
            variant: 'chapters',
            items: [
                { number: '1', title: 'The one-line script', example: './selfhost.sh', body: 'Public images from the registry, no login. Best for a first evaluation and perfectly fine for a small team in production.', media: media('', '') },
                { number: '2', title: 'Docker Compose, your way', example: 'docker compose --profile core --profile guard up -d', body: 'Eight profiles — core, search, search-gpu, search-llm, guard, whisperx, pii and analytics. Run only the services you actually want, and keep the GPU ones off a CPU box.', media: media('', '') },
                { number: '3', title: 'Kubernetes', example: 'kubectl apply -k deploy/', body: 'Eleven manifests covering the namespace, config, secrets, both app services, storage, the guard, ingress, network policy and analytics. Manual manifests today — a Helm chart is not shipped yet.', media: media('', '') },
                { number: '4', title: 'Nextcloud App Store', example: '', body: 'Install Bee Flow as a Nextcloud ExApp and it inherits your existing users, groups and files. The connector is AGPL-3.0, as the App Store requires.', media: media('', '') },
                { number: '5', title: 'Portainer or the install wizard', example: '', body: 'A stack file for Portainer, and a browser-based wizard for teams that would rather answer questions than edit YAML.', media: media('', '') },
                { number: '6', title: 'No Docker at all', example: 'npm run dev:all', body: 'A local install script for Linux, macOS and Windows that runs the server and frontend directly against a local PostgreSQL. Handy for development and for auditing what the thing does.', media: media('', '') },
            ],
        }),
        b('features', {
            eyebrow: 'What you are responsible for',
            title: 'The honest operations picture',
            lead: 'Self-hosting is a real commitment. These are the parts that are yours.',
            variant: 'classic',
            items: [
                { icon: 'Lock', span: 1, title: 'TLS and the front door', body: 'Bee Flow expects a reverse proxy in front — Caddy, nginx, Traefik or Cloudflare. Certificates are your side of the line.', techTag: '', media: media('', '') },
                { icon: 'Database', span: 1, title: 'Backups', body: 'Your PostgreSQL and your object storage hold everything. A CMS site, knowledge base or automation also exports to a file on demand.', techTag: '', media: media('', '') },
                { icon: 'Cpu', span: 1, title: 'Sizing', body: 'The core stack is modest. Transcription wants a GPU; the search and rerank services are built to run on CPU-only machines if you prefer.', techTag: '', media: media('', '') },
            ],
        }),
        b('techStats', {
            eyebrow: '',
            title: 'Deployment surface',
            stats: [
                { number: '8', label: 'Docker Compose profiles' },
                { number: '11', label: 'Kubernetes manifests' },
                { number: '1', label: 'command to a running workspace' },
                { number: '0', label: 'licence servers you must reach' },
            ],
        }, { band: 'surface' }),
        b('features', {
            eyebrow: 'Before you provision anything',
            title: 'What it needs to run',
            lead: 'Real numbers from the deployment docs, not a shrug. The core stack is deliberately modest \u2014 the expensive parts are optional and off by default.',
            variant: 'classic',
            items: [
                { icon: 'Cpu', span: 1, title: 'Minimum', body: '2 CPU cores, 4 GB RAM, 10 GB disk, and 1 GB for PostgreSQL. That is a small VM, and it is enough for a team evaluating the platform properly rather than a toy.', techTag: '2 cores \u00b7 4 GB', media: media('', '') },
                { icon: 'Server', span: 1, title: 'Recommended', body: '4 cores, 8 GB RAM, 50 GB disk, 2 GB for PostgreSQL. This is the shape most small and mid-sized organisations settle on for day-to-day production use.', techTag: '4 cores \u00b7 8 GB', media: media('', '') },
                { icon: 'Layers', span: 1, title: 'Scaling out', body: 'The server is stateless once Redis is configured, so you scale it horizontally. PostgreSQL carries every durable thing \u2014 users, agents, conversations, knowledge chunks, automation runs, the audit log \u2014 which also makes it the only thing you must back up carefully.', techTag: 'stateless + Redis', media: media('', '') },
            ],
        }),
        b('architecture', {
            eyebrow: '',
            title: 'What runs where',
            lead: '',
            layers: [
                { label: 'Always', tags: ['server', 'agent-hub', 'PostgreSQL + pgvector', 'object storage'] },
                { label: 'Recommended', tags: ['Redis (multi-replica)', 'guard-service (Privacy Shield)'] },
                { label: 'Optional', tags: ['search-service', 'reranker', 'whisperx (GPU)', 'headless browser', 'analytics'] },
            ],
        }),
        b('faq', {
            eyebrow: 'FAQ',
            title: 'What people ask before they commit a server',
            items: [
                {
                    question: 'Does it phone home, and does it stop working if it cannot?',
                    answer: 'No, and no. The core workspace runs with no licence server reachable at all \u2014 that is why the badge at the top of this page says no licence key is required. Premium features check a signed licence when you have one, but the absence of a connection degrades those features rather than stopping the platform. An air-gapped install is a supported way to run this, not a workaround.',
                },
                {
                    question: 'How do upgrades work?',
                    answer: 'Pull the new images and restart; database migrations run on server start. Pin a tag if you would rather decide when that happens \u2014 the published images are versioned, and nothing forces an upgrade on you on someone else\'s schedule. Read the release notes for the ones that change a default.',
                },
                {
                    question: 'What do we actually have to operate?',
                    answer: 'TLS and the reverse proxy in front, backups of PostgreSQL and object storage, and enough disk for whatever knowledge base you build. Everything else is containers. The honest summary is that this is the same operational weight as running any other stateful web application \u2014 not less, and worth budgeting for.',
                },
                {
                    question: 'Can we start hosted and move to our own servers later?',
                    answer: 'Yes, and it is a deliberate design goal rather than a favour. The hosted version runs the same images you would run. Sites, knowledge bases and automations export to files on demand, so the migration is an export and an import rather than a support ticket and a negotiation.',
                },
                {
                    question: 'Which parts need a GPU?',
                    answer: 'Only transcription really wants one. Search, reranking and the PII detector are all built to run on CPU-only machines, and the compose profiles keep the GPU services off a box that does not have one. You can run the whole privacy layer without special hardware.',
                },
                {
                    question: 'What do you give a security reviewer?',
                    answer: 'The source itself, a third-party licence inventory committed in the repository, and a CycloneDX SBOM generator you run against the tree yourself — we ship the script rather than a snapshot, because an SBOM checked in today describes yesterday\'s dependencies. Then a supply-chain story for extensions: marketplace modules are cryptographically signed packages whose signatures are verified before anything loads. Add the compliance checks running against the live install, and the review starts from evidence rather than from a questionnaire.',
                },
            ],
        }),
        b('cta', {
            title: 'Read the code before you trust the claims',
            lead: 'Source-available and auditable. The privacy behaviour described on this site is in the repository, not in a brochure \u2014 and running it yourself is the difference between a vendor promising sovereignty and you holding it.',
            button: { label: 'Bee-Flow/Bee-Flow', link: extLink('https://github.com/Bee-Flow/Bee-Flow') },
            secondaryCta: { label: 'How sovereignty works', link: pageLink('sovereignty') },
            showMotif: true,
            backgroundVariant: 'dark',
        }),
    ],
};

/**
 * /pricing — the slug the PRODUCT links to.
 *
 * Every `feature_locked` 403 sends the user to <host>/pricing
 * (server/core/entitlements.js:48), and LicenseContext / UpgradePrompt /
 * GuardrailsPanel hardcode the same URL. So this page must live at that slug,
 * not at a prettier one.
 *
 * NO PRICE IS WRITTEN HERE. The `pricing` block renders whatever the plans
 * table exposes via /api/billing/public-plans, which is what the admin →
 * Subscriptions panel controls. Typing a number into this file is how the
 * Dutch page ended up advertising €30/€150 that matched neither Stripe nor
 * the seeder. The block's own defaults are Dutch literals, so every label is
 * overridden below.
 */
const pricing = {
    slug: 'pricing',
    title: 'Pricing',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'Pricing — self-host free, or let us host it | Bee Flow',
        metaDescription: 'Self-hosting is free, with no user, message or agent caps in any tier. Hosted plans come from our billing config — what you see is what checkout charges.',
        ogImage: og('feature'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Pricing',
            badge: { enabled: false, text: '', icon: '' },
            titleParts: [
                { text: 'Free on your own hardware. ', gradient: false },
                { text: 'Priced when we run it.', gradient: true },
            ],
            lead: 'Self-hosting costs nothing and has no caps. The hosted version is a subscription, because the servers and the model calls are ours to pay for.',
            primaryCta: { enabled: true, label: 'Run it yourself', style: 'primary', link: pageLink('self-hosting') },
            secondaryCta: { enabled: true, label: 'How the hosted version works', style: 'secondary', link: pageLink('cloud') },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'classic',
            media: media('', ''),
        }),

        // Renders from the plans table. Everything here is a LABEL, never a
        // number — see the block header above.
        b('pricing', {
            heading: 'Hosted plans',
            subheading: 'Prices, limits and trials come straight from our billing configuration, so what you see here is what checkout charges.',
            planType: 'organization',
            enableToggle: true,
            defaultInterval: 'monthly',
            toggleLabelMonthly: 'Monthly',
            toggleLabelYearly: 'Yearly',
            ctaLabel: 'Choose plan',
            emptyText: 'No plans are open for self-service signup right now. Get in touch and we will set you up directly.',
            suffixMonthly: '/month',
            suffixYearly: '/year',
            customPriceText: 'On request',
            trialText: '{days}-day free trial',
            featuredPlanId: '',
            featuredStyle: 'border',
        }),

        b('media-text', {
            heading: 'What the monthly price actually buys',
            subheading: 'Read this before comparing us to a per-seat tool',
            body: 'On a hosted plan the price is also your monthly AI budget: the plan amount is the ceiling on what your organisation can spend on model calls that month. You are told at 80% and stopped at 100%, rather than discovering it on an invoice. Where a hosted plan carries seat or source limits, they are printed on the plan card itself — and the section above always reflects what checkout would actually charge, because both read the same billing configuration. Nothing here is metered per message, and there is no overage bill.',
            cta: null,
            // Empty media slot is fine: MediaText drops the column entirely
            // (--no-media) rather than reserving a blank half.
            media: { kind: 'image', src: '', alt: '', srcDark: '', frame: '' },
            mediaPosition: 'right', mediaSize: 'half', backgroundVariant: 'surface',
        }),

        b('content', {
            columnLayout: '2',
            verticalAlign: 'top',
            background: 'none',
            columns: [
                {
                    id: 'col_hosted',
                    elements: [{
                        id: 'el_hosted', kind: 'text',
                        heading: 'Hosted by us',
                        subheading: 'A subscription',
                        body: 'We run it on Scaleway in EU data centres, keep it patched, and handle backups and TLS. You get billing, the compliance hub, and the website builder and its analytics. A plan sets your seat count, assistant count, knowledge sources and monthly AI budget — and the cards above come straight from the live billing configuration, so what you see is what exists. Not seeing a plan that fits? Talk to us about a hosted setup before assuming the answer is no.',
                        align: 'left',
                    }],
                },
                {
                    id: 'col_self',
                    elements: [{
                        id: 'el_self', kind: 'text',
                        heading: 'Hosted by you',
                        subheading: 'Free, or a licence key',
                        body: 'Community costs nothing, needs no licence key, and enforces no caps at all - no seat limit, no message limit, no spend ceiling, because the model bill is yours. Specialist modules (meeting notes, notebooks, App Studio, the compliance hub, the support inbox) need an Enterprise licence key, which unlocks them without moving your data anywhere and is priced per deployment rather than per seat - talk to us. Licence checks are offline against a bundled public key, so an air-gapped install keeps working. The editions page lists the two side by side, row by row.',
                        align: 'left',
                    }],
                },
            ],
        }),

        b('faq', {
            eyebrow: 'FAQ',
            title: 'The questions the price list does not answer',
            items: [
                { question: 'Is the self-hosted version really uncapped?', answer: 'Yes, and that is a property of the code rather than a promise: the usage-limit checks return immediately unless the deployment is our cloud. On your own server there is no seat cap, no message cap and no spend ceiling to hit — and all 44 built-in integrations are in Community, not held back for a higher tier.' },
                { question: 'Which SSO is included in the free tier?', answer: 'Nextcloud sign-in ships in Community. Google and Microsoft SSO — including Entra ID group sync — are part of Enterprise. The identity page maps out exactly what each provider brings and what is deliberately not implemented.' },
                { question: 'What happens when a hosted plan hits its limit?', answer: 'Organisation admins get a warning email at 80% of the monthly AI budget, and requests stop at 100% with a plain message rather than a silent failure. Seat, assistant and knowledge-source limits refuse the action that would cross them and say which limit was reached.' },
                { question: 'Do I need a credit card to start?', answer: 'No. The free tier involves no checkout at all, and where a trial is offered it is created without collecting a payment method - at the end it cancels rather than charging you.' },
                { question: 'Can I move between hosted and self-hosted?', answer: 'Yes, in both directions. It is the same codebase, and websites, knowledge bases and automations all export to files. What changes is who runs the servers and who pays the model bill.' },
                { question: 'What does the licence mean for the price?', answer: LICENCE_ANSWER },
                { question: 'Why is the hosted price also a usage budget?', answer: 'Because model calls are the real cost of running this, and we would rather cap them visibly than meter you by the message and send a surprise invoice. If your team needs more headroom, the answer is a larger plan, not an overage.' },
            ],
        }),

        b('cta', {
            title: 'Not sure which side of the line you are on?',
            lead: 'Describe the team and where the data has to live. If self-hosting Community already covers you, we will say so.',
            button: { label: 'Compare the editions', link: pageLink('editions') },
            secondaryCta: { label: 'Read the self-hosting guide', link: pageLink('self-hosting') },
            showMotif: true,
            backgroundVariant: 'dark',
        }),
    ],
};

/**
 * /cloud — what the hosted version actually is.
 *
 * Every claim here is code-backed. The things deliberately NOT claimed, because
 * the repo does not support them: a hosting city or country (only the EU/EEA),
 * any uptime figure or SLA (terms.md explicitly disclaims uninterrupted
 * operation), support response times (the SLA numbers in the codebase are a
 * customer-configurable helpdesk feature, not our commitment), backup RPO/RTO,
 * ISO 27001 or SOC 2, and per-tenant database isolation.
 */
const cloud = {
    slug: 'cloud',
    title: 'Hosted',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'Managed AI workspace on EU infrastructure | Bee Flow',
        metaDescription: 'Bee Flow run for you on EU infrastructure: managed PostgreSQL and Redis, no credit card to start, and the same codebase you could self-host later.',
        ogImage: og('feature'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Hosted',
            badge: { enabled: true, text: 'No credit card to start', icon: 'Cloud' },
            titleParts: [
                { text: 'The same product, ', gradient: false },
                { text: 'without the servers', gradient: true },
            ],
            lead: 'Identical codebase, run by us on European infrastructure. Sensible when you want the workspace and not the operations - and you can still take it in-house later, because it is the same thing you could have installed yourself.',
            primaryCta: { enabled: true, label: 'Open the app', style: 'primary', link: appLink('/app') },
            secondaryCta: { enabled: true, label: 'See the plans', style: 'secondary', link: pageLink('pricing') },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'split',
            media: media(KEYS.architecture, 'Bee Flow service architecture', 'browser'),
        }),

        b('features', {
            eyebrow: 'What we run for you',
            title: 'The parts you would otherwise be on the hook for',
            lead: '',
            variant: 'bento',
            items: [
                {
                    icon: 'Server', span: 2,
                    title: 'European infrastructure',
                    body: 'Kubernetes on Scaleway, a European provider, in EU data centres by default - with the honest caveat that this holds unless you pick a model or feature whose provider sits outside the EEA. Managed PostgreSQL with pgvector and managed Redis, both run as managed services, plus TLS certificates renewed for you.',
                    techTag: 'Scaleway - EU', media: media('', ''),
                },
                {
                    icon: 'RefreshCw', span: 1,
                    title: 'Updates without a maintenance window',
                    body: 'New versions land without you scheduling anything, and without a migration you have to run yourself.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'KeyRound', span: 1,
                    title: 'Your identity provider, here too',
                    body: 'OAuth sign-in with Google, Microsoft Entra ID and Nextcloud works identically hosted and self-hosted, so hosted does not mean a separate user directory to maintain. Entra group sync needs an enterprise-app registration pinned to your tenant; on the hosted version that is arranged per deployment rather than self-service — ask us before you plan around it.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'CreditCard', span: 1,
                    title: 'Billing that lives in the product',
                    body: 'Plans, invoices, seat counts and usage against your monthly budget, all in Settings rather than in an email thread.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'ShieldCheck', span: 1,
                    title: 'The compliance hub',
                    body: '15 GDPR checks and 6 EU AI Act checks against your live configuration, plus the DSR intake and DPIA registers.',
                    techTag: '', media: media('', ''),
                },
            ],
        }),

        b('media-text', {
            heading: 'How your data is separated from everyone else\'s',
            subheading: 'Worth being precise about',
            body: 'Organisations share a database, and every tenant-scoped query filters on your organisation id - there is no separate database or schema per customer, and we would rather tell you that than imply an isolation model we do not have. On top of it sits the same encryption the self-hosted product uses: AES-256-GCM under an Argon2id-derived key, with an OPAQUE path available so a migrated account\'s password never reaches the server at all. If that is not enough separation for your risk appetite, self-hosting is the honest answer, and it is the same software.',
            cta: { label: 'Read the security model', link: pageLink('security') },
            media: { kind: 'image', src: '', alt: '', srcDark: '', frame: '' },
            mediaPosition: 'right', mediaSize: 'half', backgroundVariant: 'surface',
        }),

        b('steps', {
            eyebrow: 'Getting started',
            title: 'What signing up actually involves',
            variant: 'chapters',
            items: [
                {
                    number: '1', title: 'Create the organisation', example: 'No credit card',
                    body: 'You verify your email address with a link that expires after a day, and accept the terms and privacy policy explicitly rather than by implication. The free tier needs no checkout at all.',
                    media: media('', ''),
                },
                {
                    number: '2', title: 'Connect what you already use', example: 'Google Workspace, Microsoft 365, Nextcloud',
                    body: 'Each person connects their own account, and an assistant acts with that person\'s permissions - never more. Nothing is connected organisation-wide by default.',
                    media: media('', ''),
                },
                {
                    number: '3', title: 'Pick a plan when you outgrow the free one', example: '',
                    body: 'Upgrades take effect immediately and are prorated; downgrades take effect at the end of the period you already paid for. Where a trial is offered it needs no card and cancels itself rather than rolling into a charge.',
                    media: media('', ''),
                },
            ],
        }),

        b('trust-band', {
            variant: 'detailed',
            eyebrow: 'Sub-processors',
            title: 'Who else touches your data, and under what',
            chips: [
                { icon: 'Server', label: 'Scaleway - hosting', sublabel: 'France (EEA). Our primary infrastructure; EU data centres by default.', href: '' },
                { icon: 'CreditCard', label: 'Stripe - payments', sublabel: 'Ireland (EEA), onward to the US under the Data Privacy Framework and/or standard contractual clauses.', href: '' },
                { icon: 'Bot', label: 'Model providers - your choice', sublabel: 'Anthropic, OpenAI, Microsoft, Mistral. Which one runs depends on the model you select. Anthropic is NOT DPF-certified; those transfers rely on SCCs plus supplementary measures.', href: '' },
                { icon: 'Bell', label: '30 days\' notice before any change', sublabel: 'You get advance notice and a right to object before we add or replace a sub-processor. The current list is published.', href: '/legal/subprocessors' },
            ],
        }),

        b('media-text', {
            heading: 'What the hosted version does not promise',
            subheading: 'The part most vendors leave out',
            body: 'There is no published uptime percentage and no service level agreement - our terms say the service is provided as-is, and quoting a number we have not committed to would be worse than saying nothing. We hold no ISO 27001 or SOC 2 certification. Backups run with a defined retention and rotation, but we publish no recovery-time objective. If your procurement process needs any of those in writing, tell us what it needs and we will answer honestly rather than aspirationally - and for some organisations the right answer will be to self-host.',
            cta: { label: 'Talk to us about procurement', link: pageLink('contact') },
            media: { kind: 'image', src: '', alt: '', srcDark: '', frame: '' },
            mediaPosition: 'left', mediaSize: 'half', backgroundVariant: 'default',
        }),

        b('faq', {
            eyebrow: 'FAQ',
            title: 'Hosted vs. self-hosted',
            items: [
                { question: 'Is the hosted version a different product?', answer: 'No - the same codebase and the same container images. What differs is who operates it and how paid access works: a subscription on our cloud, a licence key on your own servers.' },
                { question: 'What can I do on the hosted version that I cannot self-host?', answer: 'Billing and subscriptions, the compliance hub, and the website builder and its analytics. Those are operator surfaces that only make sense where we run the operation.' },
                { question: 'And the other way round?', answer: 'Self-hosting gives you the Azure services panel, unsandboxed test execution, and - the big one - no usage caps of any kind, because the model bill is yours rather than ours.' },
                { question: 'Where exactly is it hosted?', answer: 'Scaleway, a European provider, in EU data centres. We deliberately do not name a specific city on this page: the region is deployment configuration, and we would rather under-claim than state something we cannot evidence. Ask and we will tell you the current region in writing.' },
                { question: 'Can we move to our own servers later?', answer: 'Yes. Websites, knowledge bases and automations export to files, your content is yours, and the self-hosted install is one command. Leaving is a decision, not a project.' },
                { question: 'Do you train models on our data?', answer: 'No. Where a model provider offers no-training or zero-retention terms we have them enabled. The stronger technical control is to point the workspace at a local model, which self-hosting allows and which means nothing leaves your network at all.' },
            ],
        }),

        b('cta', {
            title: 'Try it hosted, move it in-house if you want to',
            lead: 'The free tier needs no card, and nothing you build is locked to our servers.',
            button: { label: 'Open the app', link: appLink('/app') },
            secondaryCta: { label: 'See the plans', link: pageLink('pricing') },
            showMotif: true,
            backgroundVariant: 'dark',
        }),
    ],
};

const about = {
    slug: 'about',
    title: 'About',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'About Bee Flow — auditable AI from the Netherlands',
        metaDescription: 'Bee Flow B.V. is based in Amstelveen and builds a self-hostable, fair-code AI workspace for European organisations that need to know where their data is.',
        ogImage: og('company'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'About',
            badge: { enabled: false, text: '', icon: '' },
            titleParts: [{ text: 'Software you are allowed to check', gradient: false }],
            lead: 'Bee Flow B.V. is a Dutch company building the AI workspace we wanted to be able to buy: one that can be read, run and moved by the organisation using it.',
            primaryCta: { enabled: true, label: 'Read the source', style: 'primary', link: extLink('https://github.com/Bee-Flow/Bee-Flow') },
            secondaryCta: { enabled: true, label: 'Get in touch', style: 'secondary', link: pageLink('contact') },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'classic',
            media: media('', ''),
        }),
        b('content', {
            columnLayout: '1',
            verticalAlign: 'top',
            background: 'none',
            columns: [
                {
                    id: 'col_story',
                    elements: [
                        {
                            id: 'el_story',
                            kind: 'text',
                            heading: 'Why this exists',
                            subheading: '',
                            body: 'Most AI tooling asks European organisations to make an uncomfortable trade: real productivity in exchange for sending your documents, your customers and your contracts to infrastructure you cannot inspect and cannot move. For a hospital, a law firm, a municipality or anyone else holding other people\'s personal data, that trade is often simply not available.\n\nSo Bee Flow is built the other way round. The privacy layer is on by default rather than sold as an add-on. The deployment story starts with your own servers rather than ending there. The source is available to read, because a privacy claim you cannot verify is a marketing claim.',
                            align: 'left',
                        },
                    ],
                },
            ],
        }),
        b('media-text', {
            heading: 'How we build',
            subheading: 'Three habits, not values on a wall',
            body: 'We publish what is NOT implemented next to what is - this site says plainly that there is no SAML connector, no desktop app and no meeting bot, because finding that out during a pilot is worse than reading it here. We prefer a smaller product that describes itself accurately to a larger one that does not. And we ship the source under a fair-code licence, so the claims on this page can be checked by anyone who cares to.',
            cta: { label: 'Read the licence', link: extLink('https://github.com/Bee-Flow/Bee-Flow/blob/main/LICENSE.md') },
            media: { kind: 'image', src: KEYS.architecture, alt: 'Bee Flow service architecture', srcDark: '', frame: 'hairline' },
            mediaPosition: 'right', mediaSize: 'half', backgroundVariant: 'surface',
        }),
        // ── The founders ────────────────────────────────────────────────
        // Photos: drop `founder-tom.*` and `founder-ewoud.*` into
        // server/scripts/content/screenshots/ and re-seed, or upload them in
        // the editor. An absent file renders text-only rather than an empty
        // frame (see dropEmptyFrames + MediaText's hasMedia check).
        //
        // ON THE HARVARD LINE: it says "Harvard Kennedy School Executive
        // Education" and names the two programmes, using HKS's own spelling
        // ("Security, Strategy & Risk" — comma after Security). Not "Harvard
        // University", not "graduate", no degree implication.
        //
        // The profile is the part that actually carries weight, and it is
        // LINKED rather than described: Harvard chose to write about him, and
        // a reader can check that in one click. Third-party recognition you
        // can verify beats a credential you have to take on trust — which is
        // the same argument this whole site makes about the product. This site's whole argument
        // rests on not overclaiming — the sovereignty page carefully says
        // "chat and notebook conversations" rather than "all your data" — and
        // a stretched credential on the About page would undercut that far
        // more than it would add.
        b('media-text', {
            heading: 'Tom Kooy',
            subheading: 'Co-founder',
            body: 'Tom spent six years at Pricewise, the last three as Head of Technology & Security, building and then defending the data platform a price-comparison business runs on. That is where the habits behind this product come from: if you cannot say where a request went, you do not really control it. He also runs Kooy AI Consultancy, and completed two Harvard Kennedy School Executive Education programmes — Leading in Artificial Intelligence, and Leadership in Emerging Technology: Security, Strategy & Risk. Harvard went on to profile him about the second one, which is a fair summary of the job: the half that lets a technical answer survive a board meeting.',
            cta: { label: 'Read the Harvard Kennedy School profile', link: extLink('https://www.hks.harvard.edu/educational-programs/executive-education/adopting-emerging-technologies-private-sector') },
            media: { kind: 'image', src: shot('founder-tom') || '', alt: 'Tom Kooy, co-founder of Bee Flow', srcDark: '', frame: 'hairline' },
            mediaPosition: 'left', mediaSize: 'third', backgroundVariant: 'default',
        }),

        b('media-text', {
            heading: 'Ewoud van de Kolk',
            subheading: 'Co-founder',
            body: 'Ewoud spent a decade in e-commerce and performance marketing before deciding the interesting part was the work underneath it. He builds the automations customers actually ask for — keyword research that runs itself, sales follow-up that does not need a person to remember it — for clients including ROK Groep, Boundless Digital and Op Adem. Trained at Nyenrode Business University and certified in prompt engineering through DeepLearning.AI, he is the reason this product gets tested against commercial reality rather than only against a specification.',
            cta: null,
            media: { kind: 'image', src: shot('founder-ewoud') || '', alt: 'Ewoud van de Kolk, co-founder of Bee Flow', srcDark: '', frame: 'hairline' },
            mediaPosition: 'right', mediaSize: 'third', backgroundVariant: 'surface',
        }),

        b('features', {
            eyebrow: 'Who this is for',
            title: 'Organisations that have to answer for where the data went',
            lead: '',
            variant: 'classic',
            items: [
                { icon: 'Stethoscope', span: 1, title: 'Regulated and public sector', body: 'Care providers, municipalities and anyone under a DPIA obligation: the deployment region, the audit trail and the retention are yours to set.', techTag: '', media: media('', '') },
                { icon: 'Scale', span: 1, title: 'Professional services', body: 'Law, accountancy, consultancy - client confidentiality is not a setting you can afford to take on trust from a vendor.', techTag: '', media: media('', '') },
                { icon: 'ServerCog', span: 1, title: 'Teams who would rather host it', body: 'If your instinct on reading "AI workspace" was to ask where it runs, this was built for you. One command, your own hardware.', techTag: '', media: media('', '') },
            ],
        }),
        b('trust-band', {
            variant: 'detailed',
            eyebrow: 'The company',
            title: '',
            chips: [
                { icon: 'MapPin', label: 'Bee Flow B.V.', sublabel: 'Bovenkerkerweg 6 unit 1.12, 1185 XE Amstelveen, Netherlands', href: '' },
                { icon: 'FileCheck', label: 'KvK 97632430', sublabel: 'Registered in the Netherlands', href: '' },
                { icon: 'Scale', label: 'Sustainable Use License v1.0', sublabel: 'Source-available fair-code; the Nextcloud connector is AGPL-3.0', href: 'https://github.com/Bee-Flow/Bee-Flow/blob/main/LICENSE.md' },
                { icon: 'Github', label: 'Built in the open', sublabel: 'github.com/Bee-Flow/Bee-Flow', href: 'https://github.com/Bee-Flow/Bee-Flow' },
            ],
        }),
        b('techStats', {
            eyebrow: '',
            title: 'What we have built so far',
            stats: [
                { number: '10', label: 'workspace modules' },
                { number: '44', label: 'integrations' },
                { number: '3', label: 'ways to run it: hosted, self-hosted, Nextcloud' },
                { number: '15', label: 'automated compliance checks' },
            ],
        }, { band: 'surface' }),
        b('cta', {
            title: 'Come and look under the hood',
            lead: 'The repository is the documentation of record. If something on this site is not backed by code, we want to hear about it.',
            button: { label: 'Open the repository', link: extLink('https://github.com/Bee-Flow/Bee-Flow') },
            secondaryCta: { label: 'Contact us', link: pageLink('contact') },
            showMotif: true,
            backgroundVariant: 'dark',
        }),
    ],
};

// ── Feature pages ────────────────────────────────────────────────────
//
// These are the pages that carry a LIVE demo: the `feature-demo` block frames
// the real Studio component at /__demo__/<id>, running on fixtures with no
// network access. The copy around the frame therefore has to be precise about
// what the visitor is touching — it is the real interface, on sample data.

const automations = {
    slug: 'automations',
    title: 'Automations & automations',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'AI workflow automation you can describe by chat | Bee Flow',
        metaDescription: 'Describe a workflow and watch it assemble, or drag 27 step types on a canvas. Approval gates, dry runs and n8n import — on your own infrastructure.',
        ogImage: og('feature'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Automations & automations',
            badge: { enabled: true, text: 'Playable below — no signup', icon: 'MousePointerClick' },
            titleParts: [
                { text: 'Work that runs ', gradient: false },
                { text: 'without you in the loop', gradient: true },
            ],
            lead: 'Scheduled automations for the recurring questions, full workflows for the recurring work — and three ways to build either. Describe it in a sentence, drag it together on the canvas, or let Bee Flow point at the work it can already see you repeating. The real builder is open further down this page.',
            primaryCta: { enabled: true, label: 'Try the builder', style: 'primary', link: { kind: 'anchor', anchor: 'feature-demo' } },
            secondaryCta: { enabled: true, label: 'See the platform', style: 'secondary', link: pageLink('platform') },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'classic',
            media: media('', ''),
        }),
        b('feature-demo', {
            eyebrow: 'Live demo',
            title: 'The actual builder, in your browser',
            lead: 'Open a workflow, click a node, change a prompt, drag a step. This is the same interface the product ships — it is running on sample data instead of your mailbox.',
            feature: 'automations',
            height: 760,
            theme: 'light',
            note: 'Sample data only. The demo has no network access, so nothing you do here is saved, sent or billed — reload and it is back as it was.',
        }),
        b('steps', {
            eyebrow: 'Three ways in',
            title: 'You do not have to start with a blank canvas',
            lead: 'Most automation tools give you one way to build and assume you already know what you want. These are the three real entry points, in the order people actually use them.',
            variant: 'chapters',
            items: [
                {
                    number: '1',
                    title: 'Describe it, and watch it get built',
                    body: 'Say what you want in a sentence. The builder assembles the flow on the canvas step by step, explaining what it added and why, and leaves you something you can read and correct. It is a first draft you own, not a black box you configure \u2014 the same builder exists for internal apps, web apps and this website.',
                    example: 'Every Monday at 07:30, summarise what changed with our competitors and mail it to the team',
                    media: media('', ''),
                },
                {
                    number: '2',
                    title: 'Or build it by hand',
                    body: 'Twenty-four step types with real control flow \u2014 conditions, switches, loops, parallel branches, filters, deduplication, waits, HTTP calls and code. Drag to connect. It refuses to let you build a cycle, which is the failure you would otherwise find at three in the morning.',
                    example: 'search \u2192 loop \u2192 extract \u2192 aggregate \u2192 condition \u2192 approval \u2192 notify',
                    media: media('', ''),
                },
                {
                    number: '3',
                    title: 'Or let it point at what you keep repeating',
                    body: 'Press "find repeating work" and Bee Flow reads ninety days of your tool activity, looks read-only at your connected apps, and proposes automations for the patterns it can actually see \u2014 each labelled with how often it observed one. Suggestions grounded in your activity are separated from general ideas, so you can tell which is which. It runs when you ask it to; nothing scans in the background.',
                    example: 'gmail_search \u00d745 in the last 30 days \u00b7 weekly \u00b7 grounded in your activity',
                    media: media('', ''),
                },
            ],
        }),

        b('features', {
            eyebrow: 'What you just used',
            title: 'The parts that make it survivable in production',
            lead: '',
            variant: 'bento',
            items: [
                { icon: 'Blocks', span: 2, title: '27 step types, not just "call the AI"', body: 'Conditions, switches, loops, parallel branches, filters, dedupe, aggregation, date maths, waits, HTTP requests and sandboxed code — plus AI steps where a model genuinely helps.', techTag: '', media: media('', '') },
                { icon: 'Zap', span: 1, title: 'Four ways to start', body: 'A schedule, an inbound webhook, a manual run, or one of thirteen events in a connected app — new mail, a changed file, an upcoming meeting.', techTag: '', media: media('', '') },
                { icon: 'ShieldCheck', span: 1, title: 'Approval gates', body: 'Pause the run and wait for a person before anything irreversible happens.', techTag: '', media: media('', '') },
                { icon: 'FlaskConical', span: 1, title: 'Dry runs', body: 'See what a workflow would do, step by step, before letting it do it.', techTag: '', media: media('', '') },
                { icon: 'ScrollText', span: 1, title: 'Run history', body: 'Every run keeps a per-step log, with sensitive values redacted rather than printed.', techTag: '', media: media('', '') },
                { icon: 'Import', span: 2, title: 'Already using n8n?', body: 'Existing workflows can be imported and converted, so moving over is not a rewrite. Automations also export to a file, which makes them reviewable and portable.', techTag: '', media: media('', '') },
            ],
        }),
        b('steps', {
            eyebrow: 'Two shapes of automation',
            title: 'Pick the one that fits the job',
            variant: 'chapters',
            items: [
                { number: '1', title: 'An automation, when you want an answer', example: 'Every Monday at 07:30: what changed with our competitors?', body: 'A scheduled agent run with your instructions, your knowledge and your tools. The result lands as a message you can read, forward or feed into something else.', media: media('', '') },
                { number: '2', title: 'An automation, when you want work done', example: 'On a new file in /Clients: classify it, ask for approval, file it.', body: 'A graph of steps with real control flow. It reads and writes in your connected systems, and stops for a human whenever you tell it to.', media: media(shot('automation-canvas'), 'The automation builder', 'browser') },
                { number: '3', title: 'A Step, when you want to reuse it', example: 'Vendor lookup → used by four automations and exposed to chat.', body: 'Package a fragment once, publish it, and call it from anywhere — including as a tool your assistants can use in conversation.', media: media('', '') },
            ],
        }),
        b('faq', {
            eyebrow: 'FAQ',
            title: 'Before you build one',
            items: [
                { question: 'Can an automation touch production systems?', answer: 'Only the ones you connect, only with the tools you enable, and only within the permissions of the account you connected. Read-only connectors stay read-only — the AFAS and NMBRS integrations, for example, cannot write back.' },
                { question: 'What stops a runaway loop?', answer: 'Loops carry a maximum iteration count, runs have timeouts, code steps execute in an isolated sandbox behind an SSRF guard, and concurrency is bounded per automation. A run that misbehaves fails rather than spreading.' },
                { question: 'Does the AI see everything in the workflow?', answer: 'Only what a step passes to it, and that still goes through Privacy Shield on the way out. If a step needs no model, do not use an AI step — most of the 27 step types are ordinary logic.' },
                { question: 'Is this available on the free tier?', answer: 'Yes. Automations and scheduled automations are Community features, with no cap on how many you run.' },
            ],
        }),
        b('cta', {
            title: 'Build the one you keep doing by hand',
            lead: 'Most teams start with the report they assemble every Monday morning.',
            button: { label: 'Open the app', link: appLink('/app') },
            secondaryCta: { label: 'Ask us about your case', link: pageLink('contact') },
            showMotif: true,
            backgroundVariant: 'dark',
        }),
    ],
};

const meetingNotes = {
    slug: 'meeting-notes',
    title: 'Meeting notes',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'Self-hosted AI meeting notes and transcription | Bee Flow',
        metaDescription: 'Diarised transcripts with speaker names, summaries, decisions and action items. Seven engines, including WhisperX on your own GPU — audio stays in-house.',
        ogImage: og('feature'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Meeting notes',
            badge: { enabled: true, text: 'Playable below — no signup', icon: 'MousePointerClick' },
            titleParts: [
                { text: 'The meeting, ', gradient: false },
                { text: 'already written up', gradient: true },
            ],
            lead: 'Recording in, transcript out — with speakers identified, a summary you can send, and the action items separated from the conversation.',
            primaryCta: { enabled: true, label: 'Open a sample meeting', style: 'primary', link: { kind: 'anchor', anchor: 'feature-demo' } },
            secondaryCta: { enabled: true, label: 'How the privacy side works', style: 'secondary', link: pageLink('security') },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'classic',
            media: media('', ''),
        }),
        b('feature-demo', {
            eyebrow: 'Live demo',
            title: 'A finished meeting, exactly as the product shows it',
            lead: 'Read the transcript, jump between chapters, rename a speaker, look at the decisions and the open actions. Same interface, sample meeting.',
            feature: 'meeting-notes',
            height: 760,
            theme: 'light',
            note: 'A made-up meeting between made-up people. The demo has no microphone access and no network access — nothing is recorded, uploaded or stored.',
        }),
        b('features', {
            eyebrow: 'What it produces',
            title: 'More than a wall of text',
            lead: '',
            variant: 'bento',
            items: [
                { icon: 'Users', span: 1, title: 'Speakers, not "Speaker 1"', body: 'Diarisation separates the voices; naming them once relabels the whole transcript. Optional voice profiles recognise the same person next time.', techTag: '', media: media('', '') },
                { icon: 'ListChecks', span: 1, title: 'Actions and decisions, split out', body: 'What was agreed and what someone now owes, each with a timestamp back into the recording.', techTag: '', media: media('', '') },
                { icon: 'FileText', span: 2, title: 'Summaries in your house style', body: 'Summary templates let a team fix the shape of the output — a retrospective, a client call and a stand-up should not read the same. Templates can be personal or shared across the organisation.', techTag: '', media: media('', '') },
                { icon: 'Cpu', span: 2, title: 'Seven engines, including one on your own GPU', body: 'Use a cloud transcription provider, or run WhisperX yourself so the audio never leaves the building. The choice is per organisation, and it is a configuration change, not a migration.', techTag: '', media: media('', '') },
            ],
        }),
        b('media-text', {
            heading: 'Recordings can arrive on their own',
            subheading: 'Nextcloud Talk · Google Meet',
            body: 'A Nextcloud Talk call can be recorded and ingested automatically. Google Meet recordings are imported once Google has finished producing them — Bee Flow does not send a bot into your call, it collects the recording afterwards. Everything else is an ordinary upload.',
            cta: null,
            media: { kind: 'image', src: shot('meeting-detail'), alt: 'A finished meeting note', srcDark: '', frame: 'browser' },
            mediaPosition: 'right', mediaSize: 'half', backgroundVariant: 'surface',
        }),
        b('trust-band', {
            variant: 'detailed',
            eyebrow: 'Because this is recorded speech',
            title: '',
            chips: [
                { icon: 'ShieldCheck', label: 'Voice profiles are Article 9 data', sublabel: 'Separate explicit consent, and structurally self-only: no admin read path exists at any privilege level, we never keep the enrolment clip, and the profile is deleted the moment consent is withdrawn. Enrolment itself calls pyannoteAI, so the clip does reach that provider — the one place on this feature where audio leaves your network.', href: '' },
                { icon: 'Server', label: 'Transcription can stay in-house', sublabel: 'Run the WhisperX service on your own GPU and no audio leaves your infrastructure.', href: '' },
                { icon: 'Users', label: 'Sharing is deliberate', sublabel: 'A note is private until you publish it to your organisation or a specific group.', href: '' },
            ],
        }),
        b('faq', {
            eyebrow: 'FAQ',
            title: 'The questions recordings raise',
            items: [
                { question: 'Where is the audio stored?', answer: 'In your own object storage, alongside the rest of your data. You decide the retention; when audio is removed the note keeps its transcript and summary and simply says the recording is no longer available.' },
                { question: 'Do you need voice profiles to name speakers?', answer: 'No. Diarisation separates speakers without them, and you can name each one by hand. Voice profiles only add recognition across meetings, and they are opt-in per person with their own consent step.' },
                { question: 'Can an admin access voice profiles?', answer: 'No — by design rather than by policy. There is no read path for another person’s voice profile at any privilege level, and an organisation admin sees only how many people enrolled. Withdrawing consent deletes the profile. We never store the enrolment clip ourselves; be aware that enrolment sends it to pyannoteAI, which is why this feature is opt-in per person with its own consent step rather than on by default.' },
                { question: 'Which languages work?', answer: 'The engines are multilingual; Dutch and English are what we use daily. Pick the engine that suits your language mix — that is a per-organisation setting.' },
                { question: 'Is this on the free tier?', answer: 'No — meeting notes is an Enterprise module. The demo above is the whole interface, so you can judge it before talking to anyone.' },
            ],
        }),
        b('cta', {
            title: 'Stop writing up your own meetings',
            lead: 'Bring one recording and see what comes back.',
            button: { label: 'Open the app', link: appLink('/app') },
            secondaryCta: { label: 'Talk to us', link: pageLink('contact') },
            showMotif: true,
            backgroundVariant: 'dark',
        }),
    ],
};

/**
 * The shared spine of a feature page: hero, demo frame, closing CTA. Those
 * must look and behave the same everywhere so a visitor learns the pattern
 * once. Everything BETWEEN the demo and the close is the page's own argument,
 * passed in as `body` — because three pages that open with a demo and then
 * say the same four things in the same order is one page printed three times.
 */
function demoPage({
    slug, title, metaTitle, metaDescription, ogImage,
    eyebrow, headline, gradientTail, lead, secondaryCta,
    feature, demoTitle, demoLead, note,
    // Most demos fit 760. The organisation usage view does not — it carries
    // tabs, filters, four cards, two charts and three tables.
    demoHeight = 760,
    // Overridden only where the surface is not finished. It belongs above the
    // demo rather than inside the frame: the host deliberately adds no chrome
    // of its own, and a strip inside would eat the product's vertical space.
    demoEyebrow = 'Live demo',
    heroBadge = 'Playable below - no signup',
    body = [], faq, closing,
}) {
    return {
        slug,
        title,
        isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
        seo: { metaTitle, metaDescription, ogImage: ogImage || og('feature'), noIndex: false },
        blocks: [
            b('hero', {
                eyebrow,
                badge: { enabled: true, text: heroBadge, icon: 'MousePointerClick' },
                titleParts: gradientTail
                    ? [{ text: headline, gradient: false }, { text: gradientTail, gradient: true }]
                    : [{ text: headline, gradient: false }],
                lead,
                primaryCta: { enabled: true, label: 'Try it below', style: 'primary', link: { kind: 'anchor', anchor: 'feature-demo' } },
                secondaryCta: secondaryCta
                    ? { enabled: true, label: secondaryCta.label, style: 'secondary', link: secondaryCta.link }
                    : { enabled: true, label: 'See the platform', style: 'secondary', link: pageLink('platform') },
                mockup: { enabled: false, chatBubbles: [] },
                variant: 'classic',
                media: media('', ''),
            }),
            b('feature-demo', {
                eyebrow: demoEyebrow,
                title: demoTitle,
                lead: demoLead,
                feature,
                height: demoHeight,
                theme: 'light',
                note,
            }),
            ...body,
            b('faq', { eyebrow: 'FAQ', title: 'Worth knowing', items: faq }),
            b('cta', {
                title: closing.title,
                lead: closing.lead,
                button: { label: 'Open the app', link: appLink('/app') },
                secondaryCta: { label: 'Talk to us', link: pageLink('contact') },
                showMotif: true,
                backgroundVariant: 'dark',
            }),
        ],
    };
}

const agentsPage = demoPage({
    slug: 'assistants',
    title: 'Assistants',
    metaTitle: 'Build an AI assistant without code — the editor | Bee Flow',
    metaDescription: 'Give an assistant instructions, knowledge, tools and memory, then share it with a group. Open the real editor here, on sample assistants.',
    ogImage: og('feature'),
    eyebrow: 'Assistants',
    headline: 'An assistant per job, ',
    gradientTail: 'built by describing it',
    lead: 'No code, no prompt-engineering course. Write what it should do, attach the documents it should know, pick the tools it may use, and share it with the people who need it.',
    secondaryCta: { label: 'What it can call', link: pageLink('integrations') },
    feature: 'agents',
    demoTitle: 'The editor, with real assistants in it',
    demoLead: 'Open one, read its instructions, change the model tier, look at what knowledge and skills are attached. Three sample assistants; nothing you change is saved.',
    note: 'Sample assistants on sample data. The demo has no network access, so nothing you type is sent or stored.',
    body: [
        b('features', {
            eyebrow: 'Anatomy',
            title: 'Four things turn a chat box into an assistant',
            lead: 'Everything below is a field in the editor you just used, not a professional-services engagement.',
            variant: 'bento',
            items: [
                {
                    icon: 'ScrollText', span: 2,
                    title: 'Instructions that persist',
                    body: 'What it does, how it answers, what it must refuse. Written once, applied to every conversation, for everyone you share it with - so behaviour stops depending on who typed the best prompt that morning. A designer can draft and refine them with you if a blank box is the wrong place to start.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Library', span: 1,
                    title: 'Knowledge it can search',
                    body: 'Attach knowledge bases and the assistant answers from your documents, with numbered citations rather than a confident guess.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Wrench', span: 1,
                    title: 'Tools it may call',
                    body: 'Read the thread, file the document, book the slot. Only the tools you enable, only within the permissions of the account that connected them.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Brain', span: 1,
                    title: 'Memory, scoped',
                    body: 'Facts worth keeping are remembered per user or per project, not pooled into one bucket that leaks between colleagues.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Sparkles', span: 1,
                    title: 'Skills, when the task is specific',
                    body: 'Reusable instruction packs the assistant pulls in on demand, instead of one prompt trying to cover everything.',
                    techTag: '', media: media('', ''),
                },
            ],
        }),
        b('feature-demo', {
            eyebrow: 'Live demo',
            title: 'And this is what a skill actually is',
            lead: 'An assistant pulls in skills on demand — reusable instructions, rules and worked examples that stop you rewriting the same guidance into every assistant. Open one and read it: the house writing style, a tender triage automation, a contract-review checklist. Sample skills, nothing is saved.',
            feature: 'skills',
            height: 720,
            theme: 'light',
            note: 'Sample skills only. The demo has no network access, so edits are discarded on reload.',
        }),
        b('media-text', {
            heading: 'Sharing is the part most teams get wrong',
            subheading: 'Visibility and permissions',
            body: 'An assistant starts personal. Publish it to your organisation or to a specific group and everyone gets the same behaviour - but not necessarily the same reach: which integrations it may use is resolved against the permissions of the person talking to it, not the person who built it. So a shared assistant can never become a way around somebody else\'s access.',
            cta: { label: 'How permissions work', link: pageLink('security') },
            media: { kind: 'image', src: shot('agent-editor'), alt: 'The assistant editor', srcDark: '', frame: 'hairline' },
            mediaPosition: 'right', mediaSize: 'half', backgroundVariant: 'surface',
        }),
        b('techStats', {
            eyebrow: '',
            title: 'What an assistant can reach',
            stats: [
                { number: 'MCP', label: 'any server you point it at, on top of the 44' },
                { number: '44', label: 'built-in integrations' },
                { number: '86', label: 'curated MCP servers, plus any other' },
                { number: '11', label: 'assistants that ship ready-made' },
            ],
        }),
    ],
    faq: [
        { question: 'What makes an assistant different from just chatting?', answer: 'Instructions that persist, knowledge it can search, tools it may call, and memory scoped to the user or project. You build it once and the whole team gets the same behaviour instead of everyone re-inventing a prompt.' },
        { question: 'Who can see the assistants I build?', answer: 'You choose: personal, or shared with your organisation or a specific group. Group permissions also decide which integrations it may use on that person\'s behalf, so sharing an assistant never widens anyone\'s access.' },
        { question: 'Do I have to write the instructions myself?', answer: 'You can, and there is a designer that drafts and refines them for you. Eleven assistants also ship ready-made, including a meeting summariser and a system-prompt designer.' },
        { question: 'Which model does it use?', answer: 'Whichever you configure. Six provider adapters ship, plus any OpenAI-compatible endpoint - so an assistant can run against a local model and never leave your network.' },
        { question: 'Is this on the free tier?', answer: 'Yes. Assistants, skills and knowledge bases are Community features, with no cap on how many you create.' },
    ],
    closing: { title: 'Build the assistant your team keeps asking for', lead: 'Most teams start with the one that answers questions about their own documents.' },
});

const notebooksPage = demoPage({
    slug: 'notebooks',
    title: 'Notebooks',
    metaTitle: 'AI notebooks with cited sources | Bee Flow',
    metaDescription: 'Sources on one side, your draft on the other, and a chat that answers only from those sources with citations. Try a finished notebook.',
    ogImage: og('feature'),
    eyebrow: 'Notebooks',
    headline: 'A pile of sources, ',
    gradientTail: 'one document you can defend',
    lead: 'Put the tender, the contract and the three annexes in one place. Draft against them, and let every claim in your text point back at the page it came from — a NotebookLM-style workspace you can self-host, with your sources staying on your infrastructure.',
    secondaryCta: { label: 'How retrieval works', link: pageLink('platform') },
    feature: 'notebooks',
    demoTitle: 'A finished notebook, six sources deep',
    demoLead: 'A tender response assembled from six documents. Read the draft, open the sources, and see how the chat cites them rather than paraphrasing from memory.',
    note: 'An invented tender, invented sources. The demo has no network access - nothing is uploaded, generated or stored.',
    body: [
        b('steps', {
            eyebrow: 'How it goes',
            title: 'From six PDFs to something you would put your name on',
            variant: 'chapters',
            items: [
                {
                    number: '1', title: 'Add the sources', example: 'PDF, DOCX, XLSX, CSV, Markdown, HTML, email, a URL, a Nextcloud folder',
                    body: 'Everything the answer has to be true to, in one place. Extraction, chunking and de-duplication run as each source lands, so a 42-page tender and a two-page certificate are equally searchable a minute later.',
                    media: media('', ''),
                },
                {
                    number: '2', title: 'Interrogate them', example: 'Which requirements are knock-out and which are scored?',
                    body: 'The chat answers from those sources and nothing else, with numbered citations pointing at the document and the page. When the sources do not contain the answer it says so - which is the behaviour that makes the citations worth anything.',
                    media: media(shot('notebook'), 'A notebook with its sources and cited answers', 'browser'),
                },
                {
                    number: '3', title: 'Write the thing', example: '',
                    body: 'Draft next to the sources rather than in a separate tab, and export when it is done. Both stay in storage you control, and the conversation about them is encrypted under your own key.',
                    media: media('', ''),
                },
            ],
        }),
        b('media-text', {
            heading: 'A notebook is not a knowledge base',
            subheading: 'When to use which',
            body: 'A knowledge base is standing infrastructure: it answers questions across your whole corpus, for anyone you share it with, indefinitely. A notebook is a workspace with edges - these six documents, this deliverable, this deadline. Use a knowledge base for "what do our contracts say about notice periods". Use a notebook for "write our response to this tender". They share the same retrieval underneath, so neither is a lesser version of the other.',
            cta: null,
            media: { kind: 'image', src: KEYS.knowledgeFlow, alt: 'From documents to a cited answer', srcDark: '', frame: 'hairline' },
            mediaPosition: 'left', mediaSize: 'two-thirds', backgroundVariant: 'surface',
        }),
        b('features', {
            eyebrow: 'What comes out',
            title: 'Beyond the draft',
            lead: '',
            variant: 'classic',
            items: [
                { icon: 'FileText', span: 1, title: 'Briefing, FAQ, mind map, data table', body: 'Generated from your sources when one of those shapes is more useful than prose.', techTag: '', media: media('', '') },
                { icon: 'Quote', span: 1, title: 'Citations that survive editing', body: 'Claims stay linked to the document and page they came from, so a reviewer can check rather than trust.', techTag: '', media: media('', '') },
            ],
        }),
    ],
    faq: [
        { question: 'How is this different from a knowledge base?', answer: 'A knowledge base answers questions across your whole corpus, indefinitely. A notebook is a workspace around a specific set of sources, with a document you are writing next to them. Same retrieval underneath.' },
        { question: 'Where do the citations come from?', answer: 'From retrieval over the sources you added - hybrid vector and keyword search, reranked. If a claim has no source, the answer says so rather than filling the gap.' },
        { question: 'Can I get the document out?', answer: 'Yes - export it, or keep working in it. Your sources stay in your own storage throughout, and so does the draft.' },
        { question: 'Which file types can I add?', answer: 'PDF, Word, Excel, CSV, Markdown, HTML, plain text and email, plus a URL to crawl or a Nextcloud folder to connect.' },
        { question: 'Is it on the free tier?', answer: 'No - notebooks are an Enterprise module. The demo above is the whole interface, so you can judge it before talking to anyone.' },
    ],
    closing: { title: 'Stop rebuilding the same answer from the same six PDFs', lead: 'Bring one tender or one contract set and see what the first draft looks like.' },
});

const privacyShieldPage = demoPage({
    slug: 'privacy-shield',
    title: 'Privacy Shield',
    metaTitle: 'On-premise PII redaction for AI prompts | Bee Flow',
    metaDescription: 'Watch names, emails and IBANs be tokenised on your own hardware before the model sees them, then restored in the reply. 21 PII categories, fail-closed.',
    ogImage: og('privacy'),
    eyebrow: 'Privacy Shield',
    headline: 'Watch what ',
    gradientTail: 'actually leaves your network',
    lead: 'Install the detector and outbound prompts are inspected on your own hardware before they leave. You decide what happens next: block it, mask it, ask the person, or swap the real values for placeholders and put them back in the answer.',
    secondaryCta: { label: 'The full security model', link: pageLink('security') },
    feature: 'privacy-shield',
    // Taller than the usual 760: five tabs, and the last of them is a
    // reporting screen with an alert, four counters and a month of trend.
    demoHeight: 940,
    demoTitle: 'The rules, and what they caught last month',
    demoLead: 'This is the organisation shield as an administrator sets it: what to look for, how strict to be, what happens when something is found, and what may leave for an outside model. Then open "What happened" - a month of a fictional insurance broker\'s traffic, including the personal data that reached servers outside Europe because EU-only routing was left off.',
    note: 'The screen, the controls and the reports are the product\'s own. The organisation is invented - Van Dael Assurantien, the same company as the compliance demo - and so are its figures, though they add up. Changes are not saved and the demo has no server behind it.',
    body: [
        b('features', {
            eyebrow: 'Four answers to one question',
            title: 'What should happen when personal data is about to leave?',
            lead: 'Set it once per organisation. There is no single right answer - a hospital and a marketing agency should not pick the same one.',
            variant: 'bento',
            items: [
                {
                    icon: 'Ban', span: 1,
                    title: 'Block',
                    body: 'The message never leaves. The person is asked to rephrase. The strictest option, and the default.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'EyeOff', span: 1,
                    title: 'Redact',
                    body: 'The values are stripped and the request goes on without them. The model gets less context; you get a guarantee.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'MessageCircleQuestion', span: 1,
                    title: 'Ask',
                    body: 'The person sees what was detected and decides for that message. Useful while a team is still learning what counts as sensitive.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Repeat', span: 2,
                    title: 'Tokenise and restore',
                    body: 'Real values are swapped for placeholders like [email_1] before the request leaves, and swapped back into the answer you read. The model works on the structure of the message without ever receiving the name, the address or the account number - the option that keeps an assistant useful on real work. Enterprise.',
                    techTag: '', media: media('', ''),
                },
            ],
        }),
        b('media-text', {
            heading: 'The detector runs on your hardware, not ours',
            subheading: 'How it works',
            body: 'Detection happens in a container you run, on CPU, using an Apache-2.0 licensed model - no third-party detection API sits on the default path. Dutch BSN is validated by its checksum rather than guessed at. Data coming back from a tool is scanned on the same terms as anything you type. And if a message is going to a local model the shield steps aside: nothing is leaving, so there is nothing to inspect.',
            cta: null,
            media: { kind: 'image', src: shot('shield-redaction') || KEYS.privacyFlow, alt: 'How Privacy Shield handles an outbound prompt', srcDark: '', frame: 'hairline' },
            mediaPosition: 'left', mediaSize: 'two-thirds', backgroundVariant: 'surface',
        }),
        b('techStats', {
            eyebrow: '',
            title: 'What it looks for',
            stats: [
                { number: '21', label: 'categories, from names to API keys' },
                { number: '0', label: 'of them sent anywhere to be detected' },
                { number: 'BSN', label: 'checked by elfproef, not guessed' },
                { number: 'All', label: 'tiers - DLP is not an upsell' },
            ],
        }, { band: 'dark' }),
        b('media-text', {
            heading: 'What happens when the detector is down',
            subheading: 'Failure mode',
            body: 'The request is blocked. That is worth stating plainly, because the alternative - letting messages through unchecked while the guard is unavailable - is how a control like this quietly becomes decorative. Failing closed is occasionally inconvenient and always the right default for something whose entire job is to stop data leaving. Attachments too large to scan in full are reported rather than silently passed.',
            cta: { label: 'Read the security model', link: pageLink('security') },
            media: { kind: 'image', src: '', alt: '', srcDark: '', frame: '' },
            mediaPosition: 'right', mediaSize: 'half', backgroundVariant: 'default',
        }),
    ],
    faq: [
        { question: 'Does the detection call an external service?', answer: 'No. It runs in a container on your own hardware, on CPU, using an Apache-2.0 licensed model. An external detector can be configured if you want one, but nothing on the default path leaves your network.' },
        { question: 'What can it detect?', answer: '21 categories - names, addresses, dates of birth, phone numbers, email addresses, IBANs and other bank accounts, credit cards, passports, national identification numbers, medical conditions, API keys and more. Dutch BSN is validated by its checksum rather than guessed.' },
        { question: 'What if the detector is down?', answer: 'The request is blocked. Failing closed is the only safe default for a control whose whole job is to stop data leaving.' },
        { question: 'Does this slow every message down?', answer: 'It adds a detection pass before the request goes out. Messages to a local model skip the shield entirely, because nothing is leaving in the first place.' },
        { question: 'Is it a paid feature?', answer: 'The shield runs on every tier - DLP is not an upsell. The tokenise-and-restore round trip and the web-search guard are Enterprise.' },
        { question: 'Can I see what it caught, later?', answer: 'Yes - the "What happened" tab in the demo above is that screen. It reports what was caught, in which kind of conversation, by whom, and which outside services your data reached. Events record the category, the direction and the action taken, but never the matched text: an audit log full of the data you were protecting is a second leak.' },
    ],
    closing: { title: 'Run it yourself and watch the network', lead: 'The fastest way to check a privacy claim is to host the thing and watch what it sends.' },
});

const contact = {
    slug: 'contact',
    title: 'Contact',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'Contact Bee Flow',
        metaDescription: 'Questions about self-hosting, SSO, pricing or a custom deployment — send a note and our assistant answers from our knowledge base, with a human behind it.',
        ogImage: og('company'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Contact',
            badge: { enabled: false, text: '', icon: '' },
            titleParts: [{ text: 'Ask us something specific', gradient: false }],
            lead: 'Deployment questions, privacy review, a tricky integration, or a straight comparison against what you use now — all fair game.',
            primaryCta: { enabled: false, label: '', style: 'primary', link: { kind: 'anchor', anchor: '' } },
            secondaryCta: { enabled: false, label: '', style: 'secondary', link: { kind: 'anchor', anchor: '' } },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'classic',
            media: media('', ''),
        }),
        b('customer-support', {
            title: 'Send us a note',
            lead: 'Our assistant searches our own knowledge base and answers what it can. If it cannot fully answer you, a person takes over — and you will be told which happened. We do not publish a response time we have not committed to.',
            submitLabel: 'Send to Bee Flow',
            successTitle: 'Thanks — we have your message',
            successBody: 'You will get an email reply shortly. If the assistant cannot resolve your question on its own, a Bee Flow teammate picks it up from there.',
            backgroundVariant: 'surface',
        }),
        b('faq', {
            eyebrow: 'Before you write',
            title: 'Possibly already answered',
            items: [
                { question: 'Can we run this entirely offline?', answer: 'Yes, with a local model. The workspace, the retrieval stack and the PII detector all run without outbound internet; licence verification is offline against a bundled public key. Cloud model providers are the only part that needs the internet, and they are optional.' },
                { question: 'Do you offer a trial?', answer: 'Community is free and uncapped, so the most honest trial is to run it. For the Enterprise modules, get in touch and we will sort out a key.' },
                { question: 'Can you help us migrate?', answer: 'Tell us where you are coming from. Knowledge bases, automations and websites all import and export as files, and there is a converter for existing n8n workflows.' },
                { question: 'Where do I report a security issue?', answer: 'Use this form with "security" in the subject and it is routed to the right people. Please do not include exploit details in the first message.' },
                { question: 'We have a procurement questionnaire. Will you fill it in?', answer: 'Yes. Send it over. The data processing agreement, the sub-processor list and the security model are all published, so most of it is already answered in writing — which usually makes the round trip short.' },
                { question: 'Can we talk to someone technical?', answer: 'That is usually who replies. If your question is about deployment topology, the retrieval stack or the privacy model, say so and it goes straight to an engineer rather than through a qualification call.' },
                { question: 'Do you do pilots?', answer: 'Community is free and uncapped, so a pilot costs you infrastructure and time rather than money. If the thing you want to pilot is an Enterprise module, we will issue a key for the duration.' },
            ],
        }),
        b('trust-band', {
            variant: 'detailed',
            eyebrow: 'What to expect',
            title: '',
            chips: [
                { icon: 'Clock', label: 'A reply within a few minutes', sublabel: 'The assistant answers from our own knowledge base first; a person picks it up when it cannot finish the job.', href: '' },
                { icon: 'ShieldAlert', label: 'Security reports', sublabel: 'Put "security" in the subject and it is routed immediately. Please keep exploit detail out of the first message.', href: '' },
                { icon: 'Scale', label: 'Procurement and DPIA questions', sublabel: 'Send the questionnaire. The DPA, sub-processor list and security model are all linked in the footer.', href: '' },
            ],
        }),
        b('content', {
            columnLayout: '2',
            verticalAlign: 'top',
            background: 'none',
            columns: [
                {
                    id: 'col_addr',
                    elements: [
                        {
                            id: 'el_addr',
                            kind: 'text',
                            heading: 'Bee Flow B.V.',
                            subheading: '',
                            body: 'Bovenkerkerweg 6 unit 1.12\n1185 XE Amstelveen\nNetherlands\n\nKvK 97632430',
                            align: 'left',
                        },
                    ],
                },
                {
                    id: 'col_links',
                    elements: [
                        {
                            id: 'el_links',
                            kind: 'text',
                            heading: 'Elsewhere',
                            subheading: '',
                            body: 'Source, issues and releases live on GitHub. Legal documents — privacy policy, terms, data processing agreement and sub-processors — are linked in the footer of every page.',
                            align: 'left',
                        },
                        {
                            id: 'el_links_cta',
                            kind: 'cta',
                            label: 'github.com/Bee-Flow/Bee-Flow',
                            link: extLink('https://github.com/Bee-Flow/Bee-Flow'),
                            style: 'secondary',
                            align: 'left',
                        },
                    ],
                },
            ],
        }),
    ],
};

// ── Bundle ───────────────────────────────────────────────────────────

// ── Roadmap ───────────────────────────────────────────────────
//
// ACCURACY CONTRACT — read before editing a single word here.
//
// THE STATUSES BELOW ARE SET BY THE PRODUCT OWNER, NOT DERIVED FROM CODE.
// Do not "correct" them from betaFeatures.js. The lifecycle flags in that
// file describe how a capability is GATED; they do not say whether we are
// willing to call it finished in public, and several things the registry
// marks GA are still being actively built. Where the two disagree, this
// file wins and the owner decides.
//
// Owner-assigned, 2026-07-29:
//   building  App Studio, Web apps, Installing modules
//             (registry says GA — overridden deliberately)
//   beta      Projects (no beta chip in the app — overridden deliberately),
//             Support Inbox
//   exploring org-to-org module sales
//
// Code-derived facts that must NOT be softened, because they are checkable:
//   * authoring your own modules is blocked — package signatures verify
//     only against Bee Flow's JWKS, so a customer-signed module will not load
//   * org-to-org module sales have ZERO code: no publisher account, no
//     submission queue, no payout ledger
//
// Two hard rules, both enforced by beeflowSite.test.js:
//   * no date, quarter or version number anywhere in this page's copy —
//     terms.md disclaims uninterrupted operation and a printed "Q3" reads
//     as a commitment;
//   * every item's `status` must be one of the four values above.
// The `note` field is where the honest limitation goes (which plan, which
// jurisdiction, desktop only). Do not drop it to make a card look tidier.
const roadmapPage = {
    slug: 'roadmap',
    title: 'Roadmap',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'Roadmap — shipped, in beta, and next | Bee Flow',
        metaDescription: 'What is in beta behind an opt-in, what is in development, and what is still an idea — graded honestly by the people building it, with no dates attached.',
        ogImage: og('company'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Roadmap',
            badge: { enabled: true, text: 'Updated as things ship', icon: 'Milestone' },
            titleParts: [{ text: 'What is finished, what is half-finished, and what is still an idea', gradient: false }],
            lead: 'Most roadmaps are a wish list with a logo on it. This one is graded honestly: beta means you can switch it on today and it is in real use, in development means it exists and is not finished, and exploring means not a line of it is written. Nothing here carries a date, because a date on a roadmap is a promise and we would rather keep the ones we make.',
            primaryCta:   { enabled: true, label: 'Open the app', style: 'primary', link: appLink('/app') },
            secondaryCta: { enabled: true, label: 'Follow along on GitHub', style: 'secondary', link: extLink('https://github.com/Bee-Flow/Bee-Flow') },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'classic',
            media: media('', ''),
        }),

        b('roadmap', {
            eyebrow: 'Status',
            title: 'Where each part of the product actually stands',
            lead: 'Beta means you can use it now, behind an opt-in, while we are still changing it — not a waiting list. In development means it is real code you may already be able to reach, but we are not calling it finished yet.',
            items: [
                {
                    id: 'rm_app_studio', status: 'building', icon: 'Boxes',
                    title: 'App Studio',
                    body: 'Build internal applications against your own data model: a designer for the schema, a query layer, row-level access rules, connectors to the systems you already run, and an assistant that drafts the first version for you.',
                    note: 'Enterprise plan. Usable today and still moving — expect it to keep changing shape.',
                    link: pageLink('platform'), linkLabel: 'See the platform',
                },
                {
                    id: 'rm_webapps', status: 'building', icon: 'LayoutPanelLeft',
                    title: 'Web apps',
                    body: 'Describe a page and get working HTML, CSS and JavaScript — or React — with its own database behind it. Preview it live, let it call your integrations and automations as you, version every change, then publish, share or download the whole thing as a zip.',
                    note: 'Enterprise plan. Usable today and still moving.',
                    link: pageLink('platform'), linkLabel: 'See the platform',
                },
                {
                    id: 'rm_compliance', status: 'building', icon: 'ClipboardCheck',
                    title: 'Compliance Center',
                    body: 'A compliance workspace inside organisation settings that grades your own installation against 44 checks across GDPR, the EU AI Act and ISO 27001 — and holds the paperwork behind them. A data-subject request inbox with a public intake form, a breach register that starts the 72-hour authority clock the moment an incident is recorded, a record of processing activities, a DPIA per assistant, and for ISO a Statement of Applicability, ISMS policy documents, a risk register, internal audit and training attestations. Every register exports as a PDF.',
                    note: 'Enterprise plan, and an administrator with the compliance permission. The checks read your live configuration rather than a questionnaire, so the score describes this installation — it is not a certificate, and no auditor has signed off on how we map a check to an article.',
                    link: pageLink('compliance'), linkLabel: 'Try the demo',
                },
                {
                    id: 'rm_projects', status: 'beta', icon: 'FolderOpen',
                    title: 'Projects',
                    body: 'A workspace that holds its own knowledge, its own custom instructions and its own memory. Invite colleagues as editor or viewer, and every change lands in an activity trail.',
                    note: 'On every plan, and still settling — memory is extracted per project, so nothing leaks between them.',
                },
                {
                    id: 'rm_modules_install', status: 'building', icon: 'Puzzle',
                    title: 'Installing modules',
                    body: 'Extend the workspace with signed, versioned add-ons from the Bee Flow module hub. Each one declares exactly which permissions it wants — database, AI, email, outbound network — and an administrator has to approve that list before it runs.',
                    note: 'Installed by an administrator. Packages are signature-verified on every boot and quarantined if they fail. The catalogue is still small.',
                },
                {
                    id: 'rm_support', status: 'beta', icon: 'LifeBuoy',
                    title: 'Support Inbox',
                    body: 'Run a helpdesk inside the workspace: shared inboxes, canned replies, automations, an audit trail and per-member access. Assistants draft answers from your knowledge base without sending anything on their own.',
                    note: 'Enterprise plan, opt-in, and each member needs the support permission.',
                },
                {
                    id: 'rm_modules_author', status: 'building', icon: 'Wrench',
                    title: 'Building your own modules',
                    body: 'The packaging format, the permission manifest, the install runtime and the developer kit all exist. What is missing is the part that matters to you: a module has to be signed by Bee Flow before the product will load it, so you cannot yet build one and install it yourself.',
                    note: 'The hard part is deciding how to trust a package we did not sign, without weakening the guarantee that makes the permission list worth reading.',
                },
                {
                    id: 'rm_community', status: 'building', icon: 'MessagesSquare',
                    title: 'Feature requests you can vote on',
                    body: 'A public board where you propose something and vote on what other people have proposed, so the ordering of this page stops being ours alone. Sign in with your Bee Flow account or with GitHub; accepted requests become issues in the public repository.',
                    note: 'Requests are reviewed before they appear publicly.',
                },
                {
                    id: 'rm_module_market', status: 'exploring', icon: 'Store',
                    title: 'Buying and selling modules between organisations',
                    body: 'The idea: you build something useful for your own workspace, publish it, and another organisation installs it — paying you, not us. Everything about that is unbuilt. There is no publisher account, no review process and no way for you to be paid.',
                    note: 'Genuinely an idea at this point. It also needs answers on liability, review, and what happens to a customer whose supplier walks away.',
                },
            ],
        }),

        b('content', {
            columnLayout: '2',
            columns: [
                {
                    id: 'col_rm_how',
                    elements: [{
                        id: 'el_rm_how', kind: 'text', align: 'left',
                        heading: 'How something gets onto this page',
                        subheading: '',
                        body: 'Work starts because a customer hit a wall, not because a category looked empty. That is why the list is uneven — depth follows the customers who asked for it. When we do not know whether something is worth building, it stays under "exploring" and we say so, rather than describing it in the present tense and hoping nobody checks.',
                    }],
                },
                {
                    id: 'col_rm_beta',
                    elements: [{
                        id: 'el_rm_beta', kind: 'text', align: 'left',
                        heading: 'What beta means here',
                        subheading: '',
                        body: 'A beta feature is switched on by your administrator and is in real use — it is not a preview you join and then wait for. In development is one step behind that: the code exists and you may well be able to reach it, but we are still changing decisions inside it and would rather you knew that before you build on it. In both cases your data is treated exactly as it is everywhere else in the product; the encryption, the permissions and the audit trail have no beta version.',
                    }],
                },
            ],
        }),

        b('faq', {
            eyebrow: 'About this page',
            title: 'The obvious questions',
            items: [
                { question: 'Why are there no dates?', answer: 'Because we would miss them, and a missed date on a public page is worse than no date at all. Our terms disclaim uninterrupted operation for the same honest reason. If you need a commitment for a procurement process, ask us directly and we will put one in writing for your specific case rather than to the whole internet.' },
                { question: 'Can I use a beta feature in production?', answer: 'People do. The risk is less about stability than churn — the feature may change shape under you, and a workflow built around one screen may need adjusting. If that is a problem, wait. If you would rather influence the shape while it is still soft, switch it on and tell us what is wrong with it.' },
                { question: 'Something I need is not here at all. What now?', answer: 'Tell us. Until the public board is live, the contact form reaches a human and the GitHub repository takes issues. A request from someone who explains what they are actually trying to do beats a feature title every time.' },
                { question: 'Will you tell me when something moves?', answer: 'This page changes as things ship, and releases are published on GitHub. There is no notification list yet — that is fair criticism, and it is on the list itself.' },
                { question: 'Does self-hosting get the same features?', answer: 'Mostly, and the differences are deliberate. Billing and the hosted-only pieces do not apply when you run it yourself, and usage caps are not enforced off our cloud at all. Everything on this page that is not about subscriptions is the same code either way.' },
            ],
        }),

        b('cta', {
            title: 'Disagree with the order?',
            lead: 'That is useful. Tell us what you are trying to do and we will tell you honestly whether it is close or years away.',
            button: { label: 'Start a conversation', link: pageLink('contact') },
            secondaryCta: { label: 'Open an issue', link: extLink('https://github.com/Bee-Flow/Bee-Flow/issues') },
            showMotif: true,
            backgroundVariant: 'dark',
        }),
    ],
};


// ── Sovereignty ───────────────────────────────────────────
//
// The differentiator page, and therefore the one most likely to be read by
// someone who will check. Four claims here were narrowed against the code
// before being written down \u2014 keep them narrow:
//
//   * zero-knowledge covers CHAT AND NOTEBOOK CONVERSATIONS. Knowledge bases
//     and meeting transcripts are stored server-readable; docs/integrations/
//     google.md:157 says so outright. Never write "all your data".
//   * PII tokenization happens before the prompt leaves \u2014 but the guard
//     FAILS OPEN when it is not installed (piiDetection.js:528-537), so
//     "before data ever reaches a model" is false on a self-host without the
//     guard profile. The qualifier is not optional.
//   * local models are the generic OpenAI-compatible adapter pointed at a URL.
//     There is no Ollama adapter and no Ollama card in the UI.
//   * the Data Sovereignty Score is organisation-wide with four breakdown
//     axes. There is NO per-step score \u2014 step_id is on the row and nothing
//     groups by it. Enterprise-gated.
const sovereignty = {
    slug: 'sovereignty',
    title: 'Data sovereignty',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'Data sovereignty \u2014 measured, not promised | Bee Flow',
        metaDescription: 'Zero-knowledge keys, PII tokenised before the prompt leaves, any model including one on your own network, and a score showing where data actually went.',
        ogImage: og('privacy'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Data sovereignty',
            badge: { enabled: true, text: 'Measured, not promised', icon: 'ShieldCheck' },
            titleParts: [{ text: 'Most vendors promise sovereignty. We give you the number.', gradient: false }],
            lead: 'Every AI platform says your data is safe. Almost none will tell you which country each request actually went to. Bee Flow records the real destination of every outbound call and turns it into a score you can put in front of an auditor \u2014 alongside the four mechanisms that make the number good in the first place.',
            primaryCta:   { enabled: true, label: 'See the shield working', style: 'primary', link: pageLink('privacy-shield') },
            secondaryCta: { enabled: true, label: 'Run it yourself', style: 'secondary', link: pageLink('self-hosting') },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'classic',
            media: media('', ''),
        }),

        b('features', {
            eyebrow: 'Four mechanisms',
            title: 'Sovereignty is an architecture, not a clause in a contract',
            lead: 'Each of these is something the software does, not something we undertake to do.',
            variant: 'bento',
            items: [
                {
                    icon: 'KeyRound', span: 2,
                    title: 'Zero-knowledge encryption, keyed per person',
                    body: 'Every account gets its own data-encryption key, wrapped with Argon2id and AES-256-GCM and backed by a one-time recovery key. There is no master key and no support backdoor: an administrator resetting a password destroys that data rather than revealing it, which is the honest consequence of the design. It covers your chat and notebook conversations. Knowledge-base documents and meeting transcripts are stored server-readable \u2014 we would rather say which is which than let you assume.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Shield', span: 1,
                    title: 'Personal data replaced before the prompt leaves',
                    body: 'A detector running on your own hardware finds 21 categories \u2014 including BSN, VAT and health-insurance numbers \u2014 and swaps them for reversible tokens, restoring the real values in the answer. If the detector is installed but unreachable, the request is refused rather than sent unchecked.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Cpu', span: 1,
                    title: 'Any model, including one on your own network',
                    body: 'Adapters for Anthropic, OpenAI, Azure, Google, Google Vertex and Mistral, plus any OpenAI-compatible endpoint. Point it at a model on your own network and Bee Flow treats it as internal \u2014 those prompts skip the egress path entirely, because nothing leaves the building.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Gauge', span: 2,
                    title: 'A score, computed from where the packets actually went',
                    body: 'Bee Flow records the destination IP of every integration call at the moment the socket connects \u2014 not the hostname it meant to call, the address it reached. That becomes an organisation-wide sovereignty score out of 100, broken down by person, by app, by assistant and by category of personal data, with a per-call log underneath it. When something leaves the EEA you find out because it is on the dashboard, not because someone asks.',
                    techTag: '', media: media('', ''),
                },
            ],
        }),

        b('content', {
            columnLayout: '2',
            columns: [
                {
                    id: 'col_sov_score',
                    elements: [{
                        id: 'el_sov_score', kind: 'text', align: 'left',
                        heading: 'What the score is, precisely',
                        subheading: '',
                        body: 'It is the share of integration traffic that stayed inside the EEA or never left your network, weighted against calls that carried personal data somewhere else. It is organisation-wide, with four ways to slice it. It is not a per-step figure inside an individual automation \u2014 the data is recorded per step, but the score is not computed that way, and we would rather tell you that than let you discover it in a demo. Integration activity monitoring has to be switched on, and the dashboard is part of the Enterprise plan. You can read the live version of it on the Privacy Shield page: the "What happened" tab there is this score, with the destinations it was computed from underneath.',
                    }],
                },
                {
                    id: 'col_sov_eu',
                    elements: [{
                        id: 'el_sov_eu', kind: 'text', align: 'left',
                        heading: 'What "European" means here, and where it stops',
                        subheading: '',
                        body: 'Bee Flow B.V. is a Dutch company. The managed service runs on Scaleway in EU data centres, so your data is processed and stored in the EEA unless you choose a model or a feature hosted elsewhere. That exception is real and worth reading twice: several of the strongest models are American, and where you pick one, the transfer is covered by standard contractual clauses rather than by geography. Switch on EU mode and every model tier routes to an EU-hosted model instead. Either way the platform records where each call actually went, so the answer is a measurement rather than an assurance.',
                    }],
                },
            ],
        }),

        b('feature-demo', {
            eyebrow: 'Live demo · in development',
            title: 'Sovereignty, graded against your own installation',
            lead: 'The Compliance Center reads the workspace you are running - where the models are, who can see what, whether the retention job runs - and grades it against GDPR, the EU AI Act and ISO 27001. Switch frameworks on the left, open a failing check to see what it read, or open the Statement of Applicability and read a control exclusion. This is what turns "where did our data go" from a question into a document you can hand to an auditor.',
            feature: 'compliance',
            height: 980,
            theme: 'light',
            note: 'The Compliance Center is still in development - what you see here is real and running, but it is not finished and the details will change. The organisation is invented, the findings are invented; the checks and the Annex A catalogue are the real ones. Nothing is saved and the PDF exports are switched off because the demo has no server behind it.',
        }),
        b('steps', {
            eyebrow: 'In practice',
            title: 'What this looks like on a Tuesday',
            variant: 'chapters',
            items: [
                {
                    number: '1',
                    title: 'Someone pastes a customer email into a chat',
                    body: 'The name, the address and the account number are found and replaced before the request leaves your infrastructure. The model reasons over placeholders. The reply comes back with the real values restored, and the person never had to think about any of it.',
                    example: 'Mail sanne@voorbeeld.nl over factuur NL91 ABNA 0417 1643 00  \u2192  Mail [email_1] over factuur [iban_1]',
                    media: media('', ''),
                },
                {
                    number: '2',
                    title: 'An automation reads a mailbox at 07:30',
                    body: 'Every tool call it makes is logged with the destination IP, the country, and whether personal data was involved. Nothing about that is retrospective reconstruction \u2014 it is captured as the connection is made.',
                    example: 'gmail_search \u2192 142.250.x.x (IE) \u00b7 EU \u00b7 no PII detected',
                    media: media('', ''),
                },
                {
                    number: '3',
                    title: 'Your DPO asks where the data went last quarter',
                    body: 'You open one dashboard, filter to the period, and read the score with its breakdown and the calls behind it. The answer is the same whether the person asking is a colleague, a customer or a regulator.',
                    example: 'Sovereignty score, broken down \u00b7 by person, app, assistant, PII category',
                    media: media('', ''),
                },
            ],
        }),

        b('faq', {
            eyebrow: 'The awkward questions',
            title: 'Asked in the order a sceptic asks them',
            items: [
                { question: 'Is everything zero-knowledge encrypted?', answer: 'No, and anyone claiming that about an AI workspace is worth a second look. Your chat and notebook conversations are, with a key only you hold. Knowledge-base documents and meeting transcripts are stored server-readable, because search and diarisation need to read them. We publish which is which rather than letting the strongest claim cover the whole product.' },
                { question: 'What if I do not install the PII detector?', answer: 'Then nothing is detected and prompts go out as typed. It is an optional service, and on a self-host you have to deploy it. Once installed it is on by default across all categories, and if it becomes unreachable Bee Flow fails closed and refuses to send rather than quietly passing your data through unchecked.' },
                { question: 'Can I use a model that never leaves my network?', answer: 'Yes. Any OpenAI-compatible endpoint works \u2014 point it at a model server on your own network and Bee Flow recognises it as internal, so those prompts bypass the egress path entirely. There is no dedicated integration for a particular local runtime; it is a URL, an optional key, and a test button.' },
                { question: 'Does the score work if I self-host?', answer: 'The recording does, because it is part of the platform. The dashboard that turns it into a score is an Enterprise feature. Usage caps, for what it is worth, are not enforced off our cloud at all.' },
                { question: 'Is Bee Flow open source?', answer: LICENCE_ANSWER },
            ],
        }),

        b('trust-band', {
            variant: 'chips',
            eyebrow: 'What holds this up',
            chips: [
                { icon: 'MapPin', label: 'EU by default', sublabel: 'Dutch company, EU data centres \u2014 unless you pick a model elsewhere', href: '' },
                { icon: 'KeyRound', label: 'A key per person', sublabel: 'Chat and notebooks; no master key, no support backdoor', href: '' },
                { icon: 'Shield', label: 'PII removed on the way out', sublabel: '21 categories, on by default, fails closed', href: '' },
                { icon: 'Gauge', label: 'Egress you can read', sublabel: 'Destination IP captured as the socket connects', href: '' },
            ],
        }),

        b('cta', {
            title: 'Ask us the question you cannot get answered elsewhere',
            lead: 'Bring the one your security team keeps asking. If the answer is no, you will get a no.',
            button: { label: 'Start a conversation', link: pageLink('contact') },
            secondaryCta: { label: 'Read the architecture', link: pageLink('security') },
            showMotif: true,
            backgroundVariant: 'dark',
        }),
    ],
};

// ── Comparison pages ─────────────────────────────────────
//
// RULES FOR EVERY PAGE IN THIS SECTION. They target competitor search terms,
// which means an unusually informed reader — often one who uses the other
// product daily and will notice a single wrong detail:
//   * compare on capability and data control only;
//   * never state a competitor's price, limits or roadmap — those change and
//     we would be wrong in public. Enforced by COMPETITOR_CLAIMS in the test;
//   * no disparagement. Where they are better, say so plainly and early;
//   * every Bee Flow claim here must already be true on another page.
//
// The AI-subscription pages (ChatGPT, Gemini, Claude) have one extra rule:
// Bee Flow SHIPS those models through the provider adapters in
// server/core/providers/. Arguing that the model is worse would contradict our
// own product to the one reader who knows it. The comparison is against the
// team SUBSCRIPTION — the workspace around the model — and the line is
// "keep the model, change where it runs".
//
// Each page needs a distinct block sequence: beeflowSite.test.js fails any two
// pages sharing one. That constraint is deliberate — it stops seven pages
// becoming one page printed seven times.

/**
 * /editions — Community vs Enterprise, for the self-hosted product.
 *
 * SCOPE. This page is about the two SELF-HOSTED editions and nothing else.
 * Hosted plans on beeflow.nl are a separate axis with their own numbers, and
 * they live on /pricing where they are rendered from the live billing
 * configuration. Mixing the two is how a reader ends up believing a hosted
 * plan limit applies to their own server.
 *
 * WHAT MAY BE CLAIMED HERE. Every row was checked against the code, not
 * against the docs — `docs/docs/licensing/tiers.md` contradicts
 * `server/license/tiers.js` in at least three places and lost. The rules:
 *
 *   - A feature belongs in the Enterprise column only if a gate ACTUALLY
 *     STOPS a Community install. Several ids in the enterprise tier are
 *     declared and never enforced (audit_log_export, guardrails_dlp,
 *     automation_sharing, white_label, compliance_hub_aia/iso27001) — they
 *     are reserve boundaries, not shipped differences, and putting them in
 *     the table would sell something the product does not withhold.
 *   - The `full` tier is an operator tier for us, not a customer edition. It
 *     is not on this page.
 *   - `pro` is a legacy alias that normalises to enterprise
 *     (tiers.js LEGACY_TIER_ALIAS). There is no middle edition to describe.
 *   - No price for Enterprise: the owner's call, and it matches reality —
 *     there is no self-hosted Enterprise price anywhere in the repo.
 *
 * The uncapped claims are load-bearing and worth restating: TIER_LIMITS is
 * -1 across every tier, and the quota engine short-circuits entirely off
 * cloud (`server/core/limits.js`). "No caps" is a property of the code here,
 * not a promise.
 */
const editionsPage = {
    slug: 'editions',
    title: 'Editions',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'Community vs Enterprise editions | Bee Flow',
        metaDescription: 'Community is free, uncapped and self-hosted with every integration included. Enterprise adds meeting notes, notebooks, App Studio, SSO and compliance.',
        ogImage: og('feature'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Editions',
            badge: { enabled: true, text: 'Community needs no licence key', icon: 'Gift' },
            titleParts: [
                { text: 'Two editions, ', gradient: false },
                { text: 'and one of them is free', gradient: true },
            ],
            lead: 'Both run on your own hardware, on the same source. Community is the whole workspace with no caps and no licence key: chat, assistants, automations, knowledge bases, the privacy shield and every built-in integration. Enterprise adds the specialist modules and the identity features a larger organisation runs into, and it is priced per deployment because deployments differ.',
            primaryCta: { enabled: true, label: 'Start with Community', style: 'primary', link: pageLink('self-hosting') },
            secondaryCta: { enabled: true, label: 'Talk to us about Enterprise', style: 'secondary', link: pageLink('contact') },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'classic',
            media: media('', ''),
        }),

        b('compare-table', {
            eyebrow: 'Side by side',
            title: 'What each edition gives you',
            lead: 'Every row below is what the code does, not what a sales sheet says. Where both columns read the same, that is the point.',
            leftLabel: 'Community',
            rightLabel: 'Enterprise',
            rows: [
                { aspect: 'What it costs', left: 'Nothing. No licence key, no account, no checkout.', right: 'Priced per deployment - talk to us.' },
                { aspect: 'Where it runs', left: 'Your own hardware, air-gapped if you want.', right: 'Your own hardware, air-gapped if you want.' },
                { aspect: 'People', left: 'No user limit.', right: 'No user limit.' },
                { aspect: 'Assistants, messages, knowledge bases', left: 'No limit on any of them.', right: 'No limit on any of them.' },
                { aspect: 'Built-in integrations', left: 'All of them, including Google Workspace and Microsoft 365.', right: 'All of them.' },
                { aspect: 'MCP servers', left: 'Connect any MCP server by hand.', right: 'Same, plus the in-app catalogue for installing them.' },
                { aspect: 'Automations', left: 'The full builder, scheduling and execution.', right: 'The same builder.' },
                { aspect: 'Skills and knowledge bases', left: 'Included, with cited answers.', right: 'Included.' },
                { aspect: 'Privacy Shield', left: 'Detection on your own hardware across all 21 categories, with block or redact.', right: 'Adds tokenise-and-restore, the web-search guard, and holding personal data back from outbound tools.' },
                { aspect: 'Single sign-on', left: 'Nextcloud.', right: 'Google and Microsoft Entra ID, with automatic group sync.' },
                { aspect: 'Meeting notes and transcription', left: 'Not included.', right: 'Included, including speaker recognition.' },
                { aspect: 'Notebooks', left: 'Not included.', right: 'Included.' },
                { aspect: 'App Studio', left: 'Not included.', right: 'Included.' },
                { aspect: 'Support inbox', left: 'Not included.', right: 'Included.' },
                { aspect: 'Website builder and its analytics', left: 'Not included.', right: 'Included.' },
                { aspect: 'Compliance Center', left: 'Not included.', right: 'Included - and still in development.' },
                { aspect: 'Usage and monitoring', left: 'The overview: spend, calls, tokens, per model and per person.', right: 'Adds the safety, egress, termination and feedback reporting.' },
                { aspect: 'Licence checks', left: 'None to make.', right: 'Verified offline against a bundled public key. No phone-home, so an air-gapped install keeps working.' },
            ],
            footnote: 'Read as a list of what is withheld, this is a short list. That is deliberate: the things a small team needs are in the free edition, and the paid edition is for the modules and the identity plumbing that only start to matter at size.',
        }),

        b('features', {
            eyebrow: 'The same either way',
            title: 'Four things an edition never changes',
            lead: '',
            variant: 'bento',
            items: [
                {
                    icon: 'Users', span: 2,
                    title: 'Nobody is counting your users',
                    body: 'There is no seat cap, no message cap, no assistant cap and no knowledge-base cap in either edition — and that is a property of the code rather than a pledge. The usage-limit checks return immediately unless the deployment is our cloud, so on your own server there is nothing to hit. Growing your team is not a billing event.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Plug', span: 1,
                    title: 'Every integration, in the free edition',
                    body: 'The built-in connectors are not held back for a paid tier. Neither is the automation builder, and neither is the privacy shield.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Code', span: 1,
                    title: 'The same source, either way',
                    body: 'Enterprise is a licence key against the same code you already have. There is no separate build, and nothing to migrate to.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'WifiOff', span: 2,
                    title: 'Nothing calls home to check on you',
                    body: 'A key is verified offline against a public key that ships with the software; the refresh endpoint is opt-in and empty by default. An air-gapped installation activates and keeps running with no route to the internet at all, which is the only arrangement worth having if the reason you are self-hosting is that the data cannot leave.',
                    techTag: '', media: media('', ''),
                },
            ],
        }),

        b('content', {
            columnLayout: '2',
            verticalAlign: 'top',
            background: 'none',
            columns: [
                {
                    id: 'col_ed_lapse',
                    elements: [{
                        id: 'el_ed_lapse', kind: 'text', align: 'left',
                        heading: 'What happens if the key expires',
                        subheading: 'The part most licence pages leave out',
                        body: 'The install falls back to Community and keeps running. Nothing is deleted, nothing is locked, and no screen holds your work hostage: the specialist modules stop opening and say why, and everything else — your assistants, automations, knowledge bases, conversations — carries on exactly as before. If you renew, they come back. We would rather write that down than let you discover the answer at the worst possible moment, and it is also the honest consequence of an offline check: there is no kill switch to press.',
                    }],
                },
                {
                    id: 'col_ed_price',
                    elements: [{
                        id: 'el_ed_price', kind: 'text', align: 'left',
                        heading: 'Why Enterprise has no number here',
                        subheading: 'And what to send us',
                        body: 'Because the deployments genuinely differ, and a number on a page would be a guess dressed up as a price. What decides it is how many people will use it, which modules you actually need, and whether you want help with the installation or just the key. Tell us those three things and you get a real figure rather than a range. If Community already covers you — and for a lot of teams it does — we will say so instead of selling you a key you do not need.',
                    }],
                },
            ],
        }),

        b('techStats', {
            eyebrow: 'Community, in numbers',
            title: 'The free edition, measured',
            stats: [
                { number: '0', label: 'licence keys needed to run it' },
                { number: '0', label: 'caps on users, assistants or messages' },
                { number: 'All', label: 'built-in integrations included' },
                { number: '21', label: 'categories the privacy shield detects' },
            ],
        }, { band: 'dark' }),

        b('faq', {
            eyebrow: 'FAQ',
            title: 'The awkward edition questions',
            items: [
                { question: 'Is Community a trial?', answer: 'No. It does not expire, it is not time-limited, and it does not degrade. It needs no licence key and no account with us — you download it, run it, and we never find out. The modules listed in the right-hand column above are what a key adds; everything else is yours permanently.' },
                { question: 'Is Bee Flow open source?', answer: LICENCE_ANSWER },
                { question: 'What may I not do with the free edition?', answer: 'Two things, both from the licence rather than from the code. You may not offer Bee Flow to third parties as a hosted or managed service that competes with us, and you may not strip out the licensing notices. Running it internally for your own organisation, modifying it, and sharing it free of charge for non-commercial purposes are all explicitly allowed.' },
                { question: 'Does the Enterprise key phone home?', answer: 'No. It is a signed token verified offline against a public key bundled with the software. There is a refresh endpoint for monthly licences, but it is opt-in and unset by default, and even when it is on a failure gives you a ten-day grace period rather than an immediate lockout.' },
                { question: 'Can I move from Community to Enterprise without reinstalling?', answer: 'Yes. It is the same code and the same database — you paste a key into the admin screen and the modules appear. There is no migration, no export and no second installation, and going back is just as uneventful.' },
                { question: 'How does this relate to the hosted plans?', answer: 'It does not, directly. This page is about the two editions of the software you run yourself. The hosted version on beeflow.nl is a subscription with its own plans, where the monthly price is also your monthly AI budget — the pricing page has the current plans, generated from our live billing configuration.' },
                { question: 'Do I get support with Community?', answer: 'You get the source, the documentation and the issue tracker. What Enterprise adds is a direct line to us — the specifics are part of the conversation about your deployment rather than a tier on a page, because pretending otherwise would mean publishing a commitment we had not agreed with you.' },
            ],
        }),

        b('cta', {
            title: 'Not sure which edition you need?',
            lead: 'Describe the team, the modules you think you need and where the data has to live. If Community already covers it, that is the answer you will get.',
            button: { label: 'Ask us', link: pageLink('contact') },
            secondaryCta: { label: 'See the hosted plans', link: pageLink('pricing') },
            showMotif: true,
            backgroundVariant: 'dark',
        }),
    ],
};

const comparePage = {
    slug: 'compare',
    title: 'Compare',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'Compare Bee Flow — Microsoft, n8n, ChatGPT and more',
        metaDescription: 'Honest comparisons with Microsoft, n8n, Zapier, Make, ChatGPT, Langdock, Dust and Open WebUI — what each does better, and when we are the wrong choice.',
        ogImage: og('compare'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Compare',
            badge: { enabled: true, text: 'Including where we lose', icon: 'Scale' },
            titleParts: [{ text: 'How Bee Flow compares, without the marketing arithmetic', gradient: false }],
            lead: 'Ten comparisons, and the same two questions underneath every one of them: where does your data physically go, and can you prove it. Each page below names what the other product does better — not as a courtesy, but because you have used at least one of them and would catch us inside a paragraph. What you get for reading them is a straight answer about which one to buy, including the cases where that is not us.',
            primaryCta: { enabled: true, label: 'Open the app', style: 'primary', link: appLink('/app') },
            secondaryCta: { enabled: true, label: 'How sovereignty works', style: 'secondary', link: pageLink('sovereignty') },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'classic',
            media: media('', ''),
        }),
        b('features', {
            eyebrow: 'Pick your comparison',
            title: 'Whatever you are replacing, start here',
            lead: 'Four categories, because the question is different in each. Against Microsoft it is governance. Against the automation tools it is what runs where. Against the AI subscriptions it is whether the model is the product or a part you choose. Against the other AI workspaces it is who operates the infrastructure and what you can prove about it. One answer runs through all four: 44 integrations ship built in, and anything else reaches Bee Flow through the Model Context Protocol — including a server you write yourself, which is why the connector count is the wrong thing to compare on.',
            variant: 'bento',
            items: [
                {
                    icon: 'Building2', span: 2,
                    title: 'Microsoft Power Platform',
                    body: 'Agents, flows and internal apps — the same three things, on a stack you host, against a model you pick, with a report naming the country each prompt reached. One comparison, because Copilot Studio, Power Automate and Power Apps are one licence, one admin centre and one decision. Their Microsoft 365 integration is deeper than ours and will stay that way.',
                    techTag: 'Copilot Studio · Power Automate · Power Apps',
                    media: media('', ''), cardAction: 'link', cardUrl: '/microsoft-alternative',
                },
                {
                    icon: 'Workflow', span: 1,
                    title: 'n8n',
                    body: 'The closest comparison here, and not a hosting argument — you can already run n8n yourself. It is about what comes in the box beside the engine: assistants, cited retrieval, meeting notes and a PII layer, all on one audit trail.',
                    techTag: '', media: media('', ''), cardAction: 'link', cardUrl: '/n8n-alternative',
                },
                {
                    icon: 'Zap', span: 1,
                    title: 'Zapier',
                    body: 'The same automations on your own hardware, with personal data stripped before any model call. Zapier is quicker to start with, and you take on a stack in exchange.',
                    techTag: '', media: media('', ''), cardAction: 'link', cardUrl: '/zapier-alternative',
                },
                {
                    icon: 'Boxes', span: 1,
                    title: 'Make',
                    body: 'Keep the canvas — conditions, loops, branches, approval gates — and move it onto hardware you own. Make is genuinely nice to use; what it is not is something you can run.',
                    techTag: '', media: media('', ''), cardAction: 'link', cardUrl: '/make-alternative',
                },
                {
                    icon: 'MessageSquare', span: 1,
                    title: 'ChatGPT Teams',
                    body: 'The same GPT models, in a workspace you hold: conversations under your own key, personal data removed before the provider sees it, and automations and knowledge bases around the chat.',
                    techTag: '', media: media('', ''), cardAction: 'link', cardUrl: '/chatgpt-alternative',
                },
                {
                    icon: 'Sparkles', span: 1,
                    title: 'Gemini for Workspace',
                    body: 'The same Google Workspace connected — our deepest integration — with the model left as a setting, Gemini included. Inside Docs and Gmail, Google keeps the convenience win.',
                    techTag: '', media: media('', ''), cardAction: 'link', cardUrl: '/gemini-alternative',
                },
                {
                    icon: 'Bot', span: 1,
                    title: 'Claude Team',
                    body: 'The same Claude, in a building you own: your key on the conversations, Anthropic never receiving the customer name, and a local model for the work that should not leave.',
                    techTag: '', media: media('', ''), cardAction: 'link', cardUrl: '/claude-alternative',
                },
                {
                    icon: 'Building2', span: 1,
                    title: 'Langdock',
                    body: 'The fairest fight on this page: the other European answer. Certified and hosted where we are self-hostable and auditable — two kinds of assurance, and which one you need decides it.',
                    techTag: '', media: media('', ''), cardAction: 'link', cardUrl: '/langdock-alternative',
                },
                {
                    icon: 'Sparkles', span: 1,
                    title: 'Dust',
                    body: 'Excellent hosted agents over Slack and Notion — and theirs are deeper there than ours. Our answer runs on infrastructure you hold, with automations and audit under the same roof.',
                    techTag: '', media: media('', ''), cardAction: 'link', cardUrl: '/dust-alternative',
                },
                {
                    icon: 'TerminalSquare', span: 1,
                    title: 'Open WebUI & LibreChat',
                    body: 'You already self-host the chat, on the same local models we speak to. This comparison is about the rest: identity, redaction, automations and the audit trail around the conversation.',
                    techTag: '', media: media('', ''), cardAction: 'link', cardUrl: '/open-webui-alternative',
                },
            ],
        }),
        b('content', {
            columnLayout: '2',
            columns: [
                {
                    id: 'col_cmp_honest',
                    elements: [{
                        id: 'el_cmp_honest', kind: 'text', align: 'left',
                        heading: 'When Bee Flow is the wrong choice',
                        subheading: '',
                        body: 'If your organisation lives entirely inside Microsoft 365 and your governance already accepts Microsoft as a processor, Copilot Studio starts closer to finished than we do — we have no Teams and no SharePoint integration. If you want to connect two SaaS products in ten minutes and never think about it again, a hosted automation tool is less work than running a stack. And if nobody in your organisation has ever asked where a prompt went, you are paying for an answer you do not need. We would rather you read that here than discover it in week three of a pilot.',
                    }],
                },
                {
                    id: 'col_cmp_common',
                    elements: [{
                        id: 'el_cmp_common', kind: 'text', align: 'left',
                        heading: 'What every one of these comparisons comes down to',
                        subheading: '',
                        body: 'Two questions. Where does the data physically go, and can you prove it? Every product on this page can automate work, connect to your systems and put a language model behind it. What differs is whether the answer to those two questions is a policy document or a fact you can check by reading the source and watching the network. That is not a better feature. It is a different category of answer, and it only matters to some organisations — the ones where somebody is accountable for it.',
                    }],
                },
            ],
        }),
        b('faq', {
            eyebrow: 'Before you read further',
            title: 'How these pages are written',
            items: [
                { question: 'Do you name competitor prices?', answer: 'Never. Pricing and packaging change constantly, and a comparison page quoting a stale figure is wrong in public and looks like it is trying to mislead. Check their pricing page — it is authoritative and ours is not. A test in our build fails the site if a competitor price appears on any of these pages.' },
                { question: 'Are these written by someone who has used the other tools?', answer: 'They are written from public documentation and hands-on evaluation, and they stick to what is checkable. Where we are not certain of a detail, we leave it out rather than guess. If you find something wrong on one of these pages, tell us and we will correct it — being wrong about a competitor is worse for us than being quiet about them.' },
                { question: 'Why do the pages admit where you lose?', answer: 'Because the reader can tell. Anyone comparing platforms has used at least one of them and knows its strengths; a page that pretends otherwise loses credibility on the first paragraph and takes the rest of the site with it. Naming the gap is also how you find out quickly whether we are wrong for you.' },
                { question: 'Can you help us run the comparison ourselves?', answer: 'Yes, and the honest version is that you should. The whole stack starts with one command and no licence key, so you can rebuild one real workflow in your own environment and judge it on your own data rather than on our description of it.' },
            ],
        }),
        b('cta-banner', {
            heading: 'Bring the question nobody will answer in writing',
            subheading: 'If the answer is no, or not yet, you will get that instead.',
            layout: 'centered',
            backgroundVariant: 'primary',
            primaryCta: { label: 'Start a conversation', link: pageLink('contact') },
            secondaryCta: { label: 'Run it yourself first', link: pageLink('self-hosting') },
        }),
    ],
};

// ── Microsoft Power Platform ───────────────────────────────
//
// Merged from three pages (copilot-studio / power-automate / power-apps).
// They were one licence, one admin centre and one buying decision, and the old
// pages cross-referred to each other four times in prose — the content itself
// was asking to be one page. Old URLs 301 here from routes/publicRender.js.
const microsoftAlternative = {
    slug: 'microsoft-alternative',
    title: 'Bee Flow vs the Microsoft Power Platform',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'Copilot Studio and Power Automate alternative | Bee Flow',
        metaDescription: 'Copilot Studio, Power Automate and Power Apps in one comparison: agents, flows and internal apps on infrastructure you hold, on the model you choose.',
        ogImage: og('compare'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Comparison',
            badge: { enabled: true, text: 'For teams already using Microsoft 365', icon: 'Scale' },
            titleParts: [{ text: 'Everything you would build on the Power Platform, on infrastructure you control', gradient: false }],
            lead: 'Build the same three things — assistants over your own knowledge, workflows with real control flow, internal apps on your own data model — on a stack that comes up with one command, against the model you choose, with a report that names the country every prompt went to. Copilot Studio, Power Automate and Power Apps are one licence and one decision, so this is one comparison. They are good products and deeply wired into Microsoft 365: if your organisation lives there and the data question is already settled, they start closer to finished than we do. This page is for the teams where it is not settled.',
            primaryCta: { enabled: true, label: 'Run it yourself', style: 'primary', link: pageLink('self-hosting') },
            secondaryCta: { enabled: true, label: 'All comparisons', style: 'secondary', link: pageLink('compare') },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'classic',
            media: media('', ''),
        }),
        b('content', {
            columnLayout: '2',
            columns: [
                {
                    id: 'col_ms_fair',
                    elements: [{
                        id: 'el_ms_fair', kind: 'text', align: 'left',
                        heading: 'Where the Microsoft stack is ahead',
                        subheading: 'Said first, because it is true',
                        body: 'Maturity, reach and the head start of already being there. The Power Platform has years of polish, a very large connector catalogue and an ecosystem of people who already know it. Its Microsoft 365 integration is deeper than ours and will stay that way: our coverage is Outlook mail, calendar, contacts and OneDrive through Graph — there is no Teams integration and no SharePoint integration, and pretending otherwise would waste your evaluation. If your organisation runs on Teams and SharePoint and your governance already accepts Microsoft as a processor, they start closer to finished than we do.',
                    }],
                },
                {
                    id: 'col_ms_bite',
                    elements: [{
                        id: 'el_ms_bite', kind: 'text', align: 'left',
                        heading: 'Where the difference actually bites',
                        subheading: 'The part with no equivalent',
                        body: 'The workflows and internal apps you build are where your most specific data ends up — the case notes, the supplier terms, the HR exceptions — precisely because they are the things no off-the-shelf product handled. Choosing Bee Flow makes sense when control of that data is worth more to you than the head start. It is not a better feature; it is a different category of answer, and it only matters if someone in your organisation is accountable for it.',
                    }],
                },
            ],
        }),
        b('features', {
            eyebrow: 'Where the two differ',
            title: 'Four differences that actually change your decision',
            variant: 'bento',
            items: [
                {
                    icon: 'Server', span: 2,
                    title: 'You can run the whole thing yourself',
                    body: 'Bee Flow ships as containers you start with one command, on Docker Compose or Kubernetes, on your own hardware or in a data centre you picked. The source is published and auditable. That is the difference that makes every other difference possible — you cannot verify a claim about data handling in software you can neither read nor host.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Cpu', span: 1,
                    title: 'The model is your choice, not the vendor’s',
                    body: 'Anthropic, OpenAI, Azure OpenAI, Google, Mistral, or any OpenAI-compatible endpoint — including a model running on your own network, whose prompts never leave the building. Change your mind later without rebuilding your agents.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Shield', span: 1,
                    title: 'Personal data is removed before the model sees it',
                    body: 'Install the detector and it tokenises names, addresses, IBANs and national identifiers on the way out, on your own hardware, restoring them in the answer you read. Once installed it is on by default and it fails closed.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Gauge', span: 2,
                    title: 'Where your data went is a report, not a support ticket',
                    body: 'Bee Flow records the destination of every integration call as it happens and scores your organisation on it. You can hand that to a DPO without asking anyone for a data map. This is the part with no equivalent in the comparison — not because the other product is careless, but because a hosted service cannot show you an egress ledger for infrastructure you do not run.',
                    techTag: '', media: media('', ''),
                },
            ],
        }),
        b('steps', {
            eyebrow: 'The three halves',
            title: 'Agents, flows and internal apps — what replaces what',
            lead: 'The Power Platform splits this across three products. In Bee Flow they are one workspace with one permission model, one audit trail and one privacy layer, so a flow can call an agent and an app can read what both produced.',
            variant: 'chapters',
            items: [
                {
                    number: '1',
                    title: 'Copilot Studio — assistants over your own knowledge',
                    body: 'An assistant is instructions plus context plus tools. Bee Flow gives it long-term memory scoped to a user or a project, cited answers from your own documents, and tools it can call across your connected apps. Eleven ship ready to use. Where Copilot Studio grounds on Microsoft Graph, Bee Flow grounds on a knowledge base you own and can export.',
                    example: 'instructions · knowledge · tools · all portable, all yours',
                    media: media('', ''),
                },
                {
                    number: '2',
                    title: 'Power Automate — workflows, built three ways',
                    body: 'Describe it in a sentence and watch the canvas assemble, drag twenty-seven step types together by hand, or press "find repeating work" and let Bee Flow propose automations from ninety days of your own tool activity. Real control flow: conditions, switches, loops, parallel branches, waits, HTTP calls and code, with approval gates before anything irreversible. There is no proprietary flow format to convert — and no format to be locked into either.',
                    example: 'search → loop → extract → condition → approval → notify',
                    media: media('', ''),
                },
                {
                    number: '3',
                    title: 'Power Apps — internal apps on your own data model',
                    body: 'Tables, relationships and types in a designer, with a compiled query layer over them, and row-level access rules enforced at the gateway rather than in the screen — so a screen that forgets to filter still cannot leak. An AI builder drafts the model and the screens from a description and hands you something readable to correct. App Studio is the largest feature in the product and the owner classes it as in development; it is on the roadmap with that status, and you should evaluate it as such.',
                    example: 'schema → access rules → screens · no Dataverse licence',
                    media: media('', ''),
                },
            ],
        }),
        b('trust-band', {
            variant: 'detailed',
            eyebrow: 'What you get in exchange',
            title: 'The four facts the head start is worth trading for',
            chips: [
                { icon: 'Server', label: 'Runs on your infrastructure', sublabel: 'Docker Compose or Kubernetes, one command, no licence key required to start.', href: '' },
                { icon: 'Database', label: 'Your own PostgreSQL', sublabel: 'Inspect it, back it up, export it, keep it. No Dataverse and no proprietary store.', href: '' },
                { icon: 'Cpu', label: 'Any model, including a local one', sublabel: 'Point it at Ollama or vLLM on your own network and no prompt reaches a cloud provider.', href: '' },
                { icon: 'Globe2', label: 'Egress you can read', sublabel: 'Every outbound integration call resolved to a country at log time, non-EEA transfers flagged.', href: '' },
            ],
        }),
        b('techStats', {
            eyebrow: '',
            title: 'What you would be running',
            stats: [
                { number: '1', label: 'command to a working workspace' },
                { number: '0', label: 'licence servers you must reach' },
                { number: '24', label: 'automation step types with real control flow' },
                { number: '44', label: 'built-in integrations, plus any MCP server' },
            ],
        }, { band: 'dark' }),
        b('faq', {
            eyebrow: 'Questions',
            title: 'What people ask before switching',
            items: [
                { question: 'Do we have to leave Microsoft 365?', answer: 'No. Bee Flow connects to Outlook mail, calendar, contacts and OneDrive through Microsoft Graph, and to Google Workspace more deeply still. It sits beside what you have rather than replacing it. Entra ID also works for sign-in.' },
                { question: 'Can we import our existing flows and apps?', answer: 'No — there is no importer, and building one that produced trustworthy results is harder than it sounds. What we would say is that rebuilding is less work than it looks: agents are instructions plus knowledge plus tools, all three portable, and the AI builder drafts a first version from a description. Most of the real work is deciding which of your existing flows deserved to exist, which is worth doing once whichever product you land on.' },
                { question: 'What about the connector catalogue?', answer: mcpAnswer('The Power Platform has the largest connector catalogue of anything compared on this site, and that is a real advantage worth naming plainly.') },
                { question: 'Does it need a Microsoft licence?', answer: 'No. Bee Flow runs standalone with its own PostgreSQL. Microsoft licences only matter for the Microsoft services you choose to connect, exactly as they do today.' },
                { question: 'What stops an automation doing something expensive or irreversible?', answer: 'Approval gates before the step that matters, dry runs that show what would happen without doing it, per-integration quotas, and a builder that refuses to let you create a cycle. Every run keeps a per-step log with sensitive values redacted.' },
                { question: 'Who can see the data in an app we build?', answer: 'Row-level access rules decide which rows each person sees, and they are applied server-side at the gateway rather than in the screen. That is the difference between an access rule and a filter: a screen that forgets to filter still cannot leak.' },
                { question: 'Is it as polished as a Microsoft product?', answer: 'In places, honestly, no — several parts of the product are in beta and App Studio is in development, all labelled as such on the roadmap. What you get in exchange is the ability to read the source, host it yourself, and get a straight answer about where your data went.' },
                { question: 'What happens to our work if we stop paying?', answer: 'The self-hosted deployment keeps running; licence checks are offline against a bundled public key, so an air-gapped install does not phone home. Your data is in your own PostgreSQL and exports to open formats on demand.' },
                { question: 'Is this open source?', answer: LICENCE_ANSWER },
            ],
        }),
        b('cta', {
            title: 'Rebuild one flow and see',
            lead: 'Pick something you already run in Power Automate, rebuild it here in an afternoon, and read the egress trail afterwards. That is the comparison — not a feature grid, but whether the answer exists at all.',
            button: { label: 'Read the self-hosting guide', link: pageLink('self-hosting') },
            secondaryCta: { label: 'Ask us the hard question', link: pageLink('contact') },
            showMotif: true,
            backgroundVariant: 'dark',
        }),
    ],
};


// ── n8n ─────────────────────────────────────────────
//
// The hardest page to write honestly: n8n is self-hostable, source-available
// and genuinely excellent, so the usual "but you can run it yourself" line is
// not a differentiator here. It is also a Bee Flow INTEGRATION. The comparison
// has to be about what the platform assumes you are building, and it has to
// concede n8n's node catalogue without hedging.
const n8nAlternative = {
    slug: 'n8n-alternative',
    title: 'Bee Flow vs n8n',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'An n8n alternative with the AI workspace built in | Bee Flow',
        metaDescription: 'Both self-hostable, both source-available. The difference is what ships beside the engine: assistants, knowledge, meeting notes and a PII layer.',
        ogImage: og('compare'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Comparison',
            badge: { enabled: true, text: 'Also self-hostable, also source-available', icon: 'Scale' },
            titleParts: [{ text: 'The closest comparison on this site', gradient: false }],
            lead: 'Not a hosting argument — you already run your own infrastructure. It is about what arrives beside the workflow engine: assistants, cited retrieval, meeting notes and a PII layer, on one permission model and one audit trail. And n8n is very good; we integrate with it, which should tell you we do not think you have to choose.',
            primaryCta: { enabled: true, label: 'Try the builder', style: 'primary', link: pageLink('automations') },
            secondaryCta: { enabled: true, label: 'All comparisons', style: 'secondary', link: pageLink('compare') },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'classic',
            media: media('', ''),
        }),
        b('features', {
            eyebrow: 'Where the two differ',
            title: 'One is a workflow engine. One is a workspace with a workflow engine in it',
            lead: 'That is the whole comparison, and which side of it you want depends entirely on what you are trying to build.',
            variant: 'bento',
            items: [
                {
                    icon: 'Boxes', span: 2,
                    title: 'What n8n does better, without hedging',
                    body: 'The node catalogue. n8n has spent years building integrations and a community that builds more, and if your workflow needs a connector to something specific, the odds are far better there than here. It is also a more focused product: if a workflow engine is all you want, everything else on this page is weight you are carrying for nothing. Engineers who like it tend to like it a lot, and that is worth taking seriously.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Brain', span: 1,
                    title: 'AI is the substrate, not a node',
                    body: 'Assistants with memory and cited answers from your own documents, meeting transcription and notes, and a chat surface — all sharing the same permission model and audit trail as the automations. Not a language-model node in a flow, but a workspace the flows live inside.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Shield', span: 1,
                    title: 'A privacy layer under everything',
                    body: 'Install the detector and personal data is tokenised before any prompt reaches a model provider, on your hardware, restored in the reply. It covers the chat, the assistants and the automations at once rather than being something each flow has to remember.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Wand2', span: 2,
                    title: 'Three ways to build, including describing it',
                    body: 'Say what you want in a sentence and watch the canvas assemble step by step, drag twenty-seven step types together by hand, or press "find repeating work" and let Bee Flow read ninety days of your own tool activity and propose automations for patterns it can actually see. The third one is the interesting one: it is the difference between a tool that builds what you ask for and one that tells you what is worth building.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Plug', span: 1,
                    title: 'Nodes you do not have to wait for',
                    body: 'Where a node does not exist yet, MCP fills the gap rather than a feature request: any Model Context Protocol server plugs in over stdio or Streamable HTTP, and its tools become available to assistants and automations alike with the same permissions and the same audit trail as a built-in integration. It is a different shape of answer to the problem a large node catalogue solves — worth weighing against each other rather than counting.',
                    techTag: 'stdio · Streamable HTTP', media: media('', ''),
                },
            ],
        }),
        b('steps', {
            eyebrow: 'How to decide',
            title: 'Three questions that settle it faster than a feature grid',
            variant: 'chapters',
            items: [
                {
                    number: '1',
                    title: 'Is the workflow the product, or the plumbing?',
                    body: 'If workflows are the thing you are building and your team is comfortable in a node editor, n8n is a focused, mature answer and you should probably use it. If the workflows exist to serve people who mostly want to ask questions of their own documents and get work done in chat, then the workspace matters more than the engine.',
                    example: '',
                    media: media('', ''),
                },
                {
                    number: '2',
                    title: 'Who is going to build the second one?',
                    body: 'The first automation gets built by whoever is most technical. The tenth gets built by someone in finance who has never seen a node editor, or it does not get built. Describing a workflow in a sentence and correcting what appears is a lower floor than a blank canvas — that is the whole argument for the chat builder.',
                    example: 'Every Monday at 07:30, summarise what changed and mail it to the team',
                    media: media('', ''),
                },
                {
                    number: '3',
                    title: 'Does personal data pass through these flows?',
                    body: 'If it does, and if a language model is involved, the question becomes who sees the names and account numbers on the way out. A detector running on your own hardware, applied to everything rather than configured per flow, is the part that is hard to bolt on afterwards.',
                    example: '21 categories · on-premise · tokenise and restore',
                    media: media('', ''),
                },
            ],
        }),
        b('content', {
            columnLayout: '2',
            columns: [
                {
                    id: 'col_n8n_both',
                    elements: [{
                        id: 'el_n8n_both', kind: 'text', align: 'left',
                        heading: 'You can run both, and some teams should',
                        subheading: '',
                        body: 'n8n is a Bee Flow integration. If you already have flows you are happy with, keep them: Bee Flow can trigger them and read what they return, so an assistant can call an n8n workflow as an ordinary tool. That is a genuine answer, not a diplomatic one — rebuilding a working automation to move it between platforms is rarely the best use of anybody’s month.',
                    }],
                },
                {
                    id: 'col_n8n_licence',
                    elements: [{
                        id: 'el_n8n_licence', kind: 'text', align: 'left',
                        heading: 'On licensing, since you will check',
                        subheading: '',
                        body: 'Both projects are source-available rather than OSI open source, and both restrict reselling the product as a hosted service. We are not going to pretend there is a licensing gap between us where there is not one. Bee Flow is under the Sustainable Use License v1.0 and we are working toward AGPL-3.0-or-later; read ours, read theirs, and judge them side by side.',
                    }],
                },
            ],
        }),
        b('faq', {
            eyebrow: 'Questions',
            title: 'What people ask when they already run n8n',
            items: [
                { question: 'Can we import our n8n workflows?', answer: 'No — there is no importer, and a half-working one would cost you more time than rebuilding. The better path is usually to leave the flows where they are and connect them: n8n is a built-in integration, so an assistant or automation can trigger an existing workflow and use what it returns.' },
                { question: 'Does Bee Flow have as many connectors?', answer: mcpAnswer('Not as a node catalogue, no — and the count is the wrong axis to compare on.') },
                { question: 'Is the automation builder as capable?', answer: 'For control flow, close: 27 step types with conditions, switches, loops, parallel branches, filters, deduplication, waits, HTTP calls and code, plus approval gates and dry runs. Where we are ahead is the AI side — building by description, and automations proposed from observed activity. Where n8n is ahead is breadth of nodes.' },
                { question: 'Why would we run both?', answer: 'Because they answer different questions. Teams commonly keep n8n for the integration-heavy plumbing they already trust, and use Bee Flow for the AI workspace — assistants over their documents, meeting notes, the privacy layer — with Bee Flow calling into n8n where a flow already exists.' },
                { question: 'Is this open source?', answer: LICENCE_ANSWER },
            ],
        }),
        b('cta', {
            title: 'Open the builder and judge it yourself',
            lead: 'The real automation builder runs in your browser on this site, with sample data and nothing saved. Ten minutes with it will tell you more than this page can.',
            button: { label: 'Try the builder', link: pageLink('automations') },
            secondaryCta: { label: 'Run the whole stack', link: pageLink('self-hosting') },
            showMotif: true,
            backgroundVariant: 'dark',
        }),
    ],
};

// ── Zapier ─────────────────────────────────────────
const zapierAlternative = {
    slug: 'zapier-alternative',
    title: 'Bee Flow vs Zapier',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'A self-hosted Zapier alternative for EU teams | Bee Flow',
        metaDescription: 'The same automations on infrastructure you hold, with AI assistants and on-premise PII detection built in. Zapier starts faster; we explain the trade.',
        ogImage: og('compare'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Comparison',
            badge: { enabled: true, text: 'For teams that outgrew "it just works"', icon: 'Scale' },
            titleParts: [{ text: 'The same automations, on servers you actually control', gradient: false }],
            lead: 'Run the same automations on hardware you own, with personal data stripped before any model sees it and a log that names the country each call reached. Zapier is the fastest way to connect two SaaS products and for a great many teams it is genuinely the right tool — it is also a hosted service, so your data crosses infrastructure you do not run to get from one app to the next. This page is for the point where that stops being acceptable, which is usually when the data becomes personal, regulated, or someone else’s.',
            primaryCta: { enabled: true, label: 'Try the builder', style: 'primary', link: pageLink('automations') },
            secondaryCta: { enabled: true, label: 'All comparisons', style: 'secondary', link: pageLink('compare') },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'classic',
            media: media('', ''),
        }),
        b('content', {
            columnLayout: '2',
            columns: [
                {
                    id: 'col_zap_fair',
                    elements: [{
                        id: 'el_zap_fair', kind: 'text', align: 'left',
                        heading: 'Where Zapier wins, and it is not close',
                        subheading: '',
                        body: 'Breadth and time-to-first-automation. Zapier connects to thousands of applications and gets a working automation running in minutes with no infrastructure at all. If you want to post new form submissions into a channel and never think about it again, running a container stack to do it would be a strange decision. Nothing on this page is an argument that Zapier is bad at what it does — it is an argument about where the work runs.',
                    }],
                },
                {
                    id: 'col_zap_when',
                    elements: [{
                        id: 'el_zap_when', kind: 'text', align: 'left',
                        heading: 'When teams start looking for something else',
                        subheading: '',
                        body: 'Almost always the same trigger: the automation starts touching personal data. A candidate CV, a patient reference, a customer complaint with a name and an address in it. At that moment the question changes from "does this work" to "who processed this, in which country, and can I evidence it". A hosted automation service can answer that with a policy. It cannot answer it with an egress log for infrastructure you do not run.',
                    }],
                },
            ],
        }),
        b('steps', {
            eyebrow: 'Moving across',
            title: 'What rebuilding actually involves',
            variant: 'chapters',
            items: [
                {
                    number: '1',
                    title: 'Bring the stack up',
                    body: 'One command starts the workspace, the retrieval stack and the privacy guard. No licence key, no sales call, no card. This is the step that does not exist with a hosted tool, and it is the honest cost of the trade.',
                    example: './selfhost.sh',
                    media: media('', ''),
                },
                {
                    number: '2',
                    title: 'Describe the automation you already have',
                    body: 'Rather than dragging it out node by node, say what it does in a sentence and let the builder assemble a first version you correct. Most single-trigger automations come across in minutes because they were never complicated — they were just tedious to wire up.',
                    example: 'When a form is submitted, summarise it and file it in the right folder',
                    media: media('', ''),
                },
                {
                    number: '3',
                    title: 'Connect the same accounts, then read the trail',
                    body: 'Each person connects their own account by OAuth, and an integration acts as the person who authorised it. Afterwards, open the sovereignty view and read which country each call went to. That report is the thing you could not get before.',
                    example: 'per-user OAuth · per-group permissions · egress by country',
                    media: media('', ''),
                },
            ],
        }),
        b('features', {
            eyebrow: 'What you gain in the trade',
            title: 'Four things a hosted automation service structurally cannot give you',
            variant: 'classic',
            items: [
                { icon: 'Server', span: 1, title: 'The automation runs on your hardware', body: 'Containers on your own machine or a data centre you chose, in a region you picked. The data does not transit a third party to get from one of your systems to another.', techTag: '', media: media('', '') },
                { icon: 'Shield', span: 1, title: 'Personal data can be stripped before any model sees it', body: 'Install the detector and names, addresses, IBANs and national identifiers are tokenised on the way out and restored in the reply — running on your own CPU, not a detection API.', techTag: '', media: media('', '') },
                { icon: 'Cpu', span: 1, title: 'The AI in the automation is yours to choose', body: 'Any provider, or a model on your own network whose prompts never leave the building. Not a bundled assistant you cannot swap.', techTag: '', media: media('', '') },
                { icon: 'Plug', span: 1, title: 'The integration list is not a ceiling', body: '44 integrations ship built in, and then Bee Flow speaks the Model Context Protocol — so any MCP server becomes tools your automations can call, over stdio or Streamable HTTP. The public ones, the ones your vendors publish, and the one you write yourself for the line-of-business system nobody has ever built a connector for. Self-host and installing them is your decision rather than a request you file with a vendor and wait on.', techTag: '44 built in · plus any MCP server', media: media('', '') },
            ],
        }),
        b('faq', {
            eyebrow: 'Questions',
            title: 'What people ask when they are leaving a hosted tool',
            items: [
                { question: 'Can we import our Zaps?', answer: 'No — there is no importer. In practice most single-trigger automations are quicker to describe in a sentence and correct than to convert, and the chat builder is designed for exactly that. Multi-step flows with a lot of branching take longer, and we would rather say so.' },
                { question: 'Do you have as many integrations?', answer: mcpAnswer('Not as a catalogue — but the practical answer is open-ended rather than smaller.') },
                { question: 'Is it harder to run?', answer: 'Yes. That is the trade and it should be stated plainly: you are taking on a container stack, a database, backups and TLS, against a service where somebody else does all of that. The minimum is 2 CPU cores and 4 GB of RAM. If nobody in your organisation wants to own that, a hosted tool is the better answer.' },
                { question: 'What about the AI features?', answer: 'They are not an add-on here. Assistants with memory, cited answers over your own documents, meeting notes and the privacy layer share the same permission model and audit trail as the automations, so a workflow can call an assistant and both appear in one trail.' },
                { question: 'Can we host it in the EU?', answer: 'You choose the region entirely, because you choose the infrastructure. The platform also resolves every integration endpoint to a country at log time and flags transfers outside the EEA, so "is this data leaving Europe" becomes something you read rather than something you assume.' },
            ],
        }),
        b('cta-banner', {
            heading: 'Rebuild one automation and compare the trail',
            subheading: 'Take the one that touches personal data. That is where the difference shows up.',
            layout: 'centered',
            backgroundVariant: 'primary',
            primaryCta: { label: 'Try the builder', link: pageLink('automations') },
            secondaryCta: { label: 'What it takes to run', link: pageLink('self-hosting') },
        }),
    ],
};

// ── Make ───────────────────────────────────────────
const makeAlternative = {
    slug: 'make-alternative',
    title: 'Bee Flow vs Make',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'A self-hostable Make (Integromat) alternative | Bee Flow',
        metaDescription: 'The same visual workflow building, running on your own infrastructure, with AI assistants and on-premise PII detection sharing one permission model.',
        ogImage: og('compare'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Comparison',
            badge: { enabled: true, text: 'Visual building, your infrastructure', icon: 'Scale' },
            titleParts: [{ text: 'Keep the canvas. Move where it runs', gradient: false }],
            lead: 'Keep the visual canvas — conditions, loops, parallel branches, and an approval gate in front of the irreversible step — and move it onto hardware you own, with a privacy layer the scenario never has to remember to apply. Make is one of the nicest visual builders anyone has shipped, and people who use it enjoy using it, which is rarer in this category than it should be. What it is not is something you can run yourself. This page is about what changes when that starts to matter, and what it costs you.',
            primaryCta: { enabled: true, label: 'Try the builder', style: 'primary', link: pageLink('automations') },
            secondaryCta: { enabled: true, label: 'All comparisons', style: 'secondary', link: pageLink('compare') },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'classic',
            media: media('', ''),
        }),
        b('features', {
            eyebrow: 'Where the two differ',
            title: 'What changes when the canvas runs on your own hardware',
            variant: 'bento',
            items: [
                {
                    icon: 'Boxes', span: 2,
                    title: 'What Make does better',
                    body: 'The editing experience and the app catalogue. Make’s canvas handles complex branching visually better than most tools manage, the iteration and aggregation model is elegant, and there are far more app connectors than we ship. If you are happy with where your scenarios run, none of this page is a reason to move — switching tools has a cost and enjoying the one you have is a real benefit.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'GitBranch', span: 1,
                    title: 'Real control flow, on a canvas you drag',
                    body: 'Twenty-four step types: conditions, switches, loops, parallel branches, filters, deduplication, waits, HTTP calls and code. The builder refuses to let you create a cycle, which is the failure you would otherwise find at three in the morning.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Shield', span: 1,
                    title: 'A privacy layer the scenario does not have to remember',
                    body: 'Install the detector and personal data is tokenised before any prompt leaves for a model provider, on your own hardware. It applies across chat, assistants and automations at once rather than being wired into each flow.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'ShieldCheck', span: 2,
                    title: 'Approval gates before the irreversible step',
                    body: 'A scenario that sends an email, issues a refund or deletes a record can pause and wait for a person. Dry runs show exactly what would happen without doing it, and every run keeps a per-step log with sensitive values redacted — so when something goes wrong you can see what it did, not just that it failed.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Plug', span: 1,
                    title: 'Past the end of the app list',
                    body: 'The 44 built-in integrations are where it starts, not where it stops. Bee Flow speaks the Model Context Protocol, so a scenario can reach anything with an MCP server in front of it — the public ones, the ones your vendors publish, and one you write yourself for an internal system that will never appear in anybody’s app directory. Self-host and you install those; nothing waits on a vendor roadmap.',
                    techTag: 'any MCP server, including your own', media: media('', ''),
                },
            ],
        }),
        b('content', {
            columnLayout: '2',
            columns: [
                {
                    id: 'col_make_why',
                    elements: [{
                        id: 'el_make_why', kind: 'text', align: 'left',
                        heading: 'The reason people actually move',
                        subheading: '',
                        body: 'It is rarely a missing feature. It is a scenario that started out moving rows between two systems and ended up handling names, addresses and case details, at which point someone asks where those fields are being processed and whether a model provider saw them. On a hosted platform the honest answer is a policy document. On infrastructure you run, it is a log you can read.',
                    }],
                },
                {
                    id: 'col_make_cost',
                    elements: [{
                        id: 'el_make_cost', kind: 'text', align: 'left',
                        heading: 'The cost, stated plainly',
                        subheading: '',
                        body: 'You take on operations. A container stack, a PostgreSQL to back up, TLS at the front door, and enough disk for whatever knowledge base you build — 2 CPU cores and 4 GB of RAM at minimum, 4 and 8 recommended. That is the same weight as running any other stateful web application, and it is a real cost rather than a footnote. If nobody wants to own it, the hosted tool is the right answer and we would rather you kept it.',
                    }],
                },
            ],
        }),
        b('trust-band', {
            variant: 'detailed',
            eyebrow: 'What you get for taking that on',
            title: 'Four things that stop being someone else’s decision',
            chips: [
                { icon: 'MapPin', label: 'The region is yours to pick', sublabel: 'You choose where it runs, and every integration endpoint is resolved to a country at log time.', href: '' },
                { icon: 'Cpu', label: 'The model is yours to pick', sublabel: 'Any provider, or a local model on your own network whose prompts never leave the building.', href: '' },
                { icon: 'Database', label: 'The data is in your own PostgreSQL', sublabel: 'Inspect it, back it up, export it. Automations and knowledge bases export to open formats on demand.', href: '' },
                { icon: 'FileSearch', label: 'The source is readable', sublabel: 'Every claim on this page is checkable against the repository rather than a trust exercise.', href: '' },
            ],
        }),
        b('faq', {
            eyebrow: 'Questions',
            title: 'What people ask when they are moving scenarios',
            items: [
                { question: 'Can we import our scenarios?', answer: 'No — there is no importer, and we would rather say that than ship one that half-works. Describing an existing scenario in a sentence and correcting the first draft is usually faster than a conversion tool would be anyway; heavily branched scenarios are the ones that take real time.' },
                { question: 'Is the visual builder as good?', answer: 'Honestly, for pure canvas ergonomics Make has the edge — it is a focused product and it shows. What we add is that you do not have to start on the canvas at all: describe the workflow and it assembles, or let Bee Flow propose automations from work it can see you repeating, then open the canvas to correct.' },
                { question: 'What happens to a running automation if the licence lapses?', answer: 'The self-hosted deployment keeps running. Licence checks are offline against a bundled public key, so an air-gapped install never phones home and no automation stops because a server somewhere was unreachable.' },
                { question: 'Do you have as many app connectors?', answer: mcpAnswer('Not as a curated app list, and the number understates what you can actually reach.') },
                { question: 'Can an automation use AI without sending data outside?', answer: 'Yes. Point Bee Flow at a model running on your own network — Ollama, vLLM, or any OpenAI-compatible endpoint — and no prompt reaches a cloud provider at all. That configuration is why the privacy layer and the local-model support belong in the same product as the workflow engine.' },
            ],
        }),
        b('cta', {
            title: 'Rebuild the scenario you are least comfortable with',
            lead: 'The one handling data you would rather not explain in an audit. Build it here, then read where every call went.',
            button: { label: 'Try the builder', link: pageLink('automations') },
            secondaryCta: { label: 'How sovereignty works', link: pageLink('sovereignty') },
            showMotif: true,
            backgroundVariant: 'dark',
        }),
    ],
};


// ── ChatGPT Teams ─────────────────────────────────────
const chatgptAlternative = {
    slug: 'chatgpt-alternative',
    title: 'Bee Flow vs ChatGPT Teams',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'A self-hosted ChatGPT alternative for teams | Bee Flow',
        metaDescription: 'Run the same OpenAI models — or Claude, Gemini, Mistral or a local model — in a workspace you host, with PII stripped before the prompt leaves.',
        ogImage: og('compare'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Comparison',
            badge: { enabled: true, text: 'Keep the model, change where it runs', icon: 'Scale' },
            titleParts: [{ text: 'The same models. A workspace you actually hold', gradient: false }],
            lead: 'Keep the models you use today — Bee Flow ships an OpenAI adapter — and change what surrounds them: conversations encrypted under a key you hold, personal data removed before the provider sees it, and one workspace carrying your automations, your knowledge bases and your meeting notes rather than a chat window on its own. ChatGPT Teams has the better chat experience and gets new model capabilities first; this page is about everything that is not the chat window.',
            primaryCta: { enabled: true, label: 'Open the app', style: 'primary', link: appLink('/app') },
            secondaryCta: { enabled: true, label: 'All comparisons', style: 'secondary', link: pageLink('compare') },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'classic',
            media: media('', ''),
        }),
        b('content', {
            columnLayout: '2',
            columns: [
                {
                    id: 'col_gpt_fair',
                    elements: [{
                        id: 'el_gpt_fair', kind: 'text', align: 'left',
                        heading: 'Where ChatGPT Teams is ahead',
                        subheading: 'And it genuinely is',
                        body: 'The chat experience itself, and the speed at which new model capabilities land. OpenAI ships to their own product first, and a team that just wants the best chat interface with the newest models will feel that difference. The apps and voice experience are excellent. If your organisation has no constraint on where conversations are processed, that head start is real and this page will not talk you out of it.',
                    }],
                },
                {
                    id: 'col_gpt_diff',
                    elements: [{
                        id: 'el_gpt_diff', kind: 'text', align: 'left',
                        heading: 'What a subscription cannot change',
                        subheading: 'The structural part',
                        body: 'In a hosted workspace the model vendor is also the operator: the same company holds the conversations, runs the retrieval and decides the region. That is not a criticism, it is the architecture you are buying. It means the answer to "was this personal data sent to a provider" is a contractual assurance rather than a log entry, and that switching models later means switching products. Bee Flow separates the two — the model is a setting, the workspace is yours.',
                    }],
                },
            ],
        }),
        b('features', {
            eyebrow: 'What changes',
            title: 'Four differences that follow from holding the workspace',
            variant: 'bento',
            items: [
                {
                    icon: 'Cpu', span: 2,
                    title: 'Every model, including the one you are using now',
                    body: 'OpenAI, Anthropic, Google, Azure OpenAI, Mistral, or any OpenAI-compatible endpoint — including a model running on your own network. Different assistants can use different models, so the expensive one handles the hard work and a local model handles anything touching personal data. Changing your mind later is a dropdown, not a migration.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Lock', span: 1,
                    title: 'Conversations encrypted under your own key',
                    body: 'Chat and notebook conversations are encrypted with a key derived from the user’s password using Argon2id. Knowledge-base documents and meeting transcripts are stored server-readable, because search and diarisation must read them — we would rather name the boundary than let the strongest claim cover everything.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Shield', span: 1,
                    title: 'Personal data removed before the provider sees it',
                    body: 'Install the detector and names, addresses, IBANs and national identifiers are tokenised on your own hardware before the prompt leaves, then restored in the answer you read. The model does its job without ever receiving the name.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Workflow', span: 2,
                    title: 'The chat is one surface, not the whole product',
                    body: 'The same workspace runs automations with approval gates, internal apps over your own data model, meeting transcription with speaker identification, and cited answers over your documents — all sharing one permission model and one audit trail. A conversation can trigger a workflow, and both appear in the same trail.',
                    techTag: '', media: media('', ''),
                },
            ],
        }),
        b('techStats', {
            eyebrow: '',
            title: 'What sits under the chat window',
            stats: [
                { number: '6', label: 'model providers, plus any OpenAI-compatible endpoint' },
                { number: '21', label: 'PII categories detected on your own hardware' },
                { number: '44', label: 'built-in integrations, plus any MCP server' },
                { number: '0', label: 'licence servers a self-hosted install must reach' },
            ],
        }, { band: 'dark' }),
        b('faq', {
            eyebrow: 'Questions',
            title: 'What people ask before moving off a chat subscription',
            items: [
                { question: 'Can we keep using GPT models?', answer: 'Yes, and many teams do. Bee Flow ships an OpenAI adapter and an Azure OpenAI adapter; you bring your own API key and the models behave exactly as they do today. What changes is that the conversation history, the retrieval and the audit trail live in your workspace instead of the provider’s.' },
                { question: 'Is the chat as good?', answer: 'The chat interface is good and improving, but a company whose entire product is the chat window will keep an edge there — that is an honest read of it. Where we are ahead is everything around the window: your own knowledge base with citations, automations, meeting notes, and the fact that the model is a choice rather than the product.' },
                { question: 'How do we stop staff pasting customer data into a model?', answer: 'That is what the detector is for. Once installed it inspects prompts on the way out and, per organisation, will block, redact, ask the user, or tokenise and restore. It runs in a container on your own hardware on CPU, so the inspection itself does not involve a third party.' },
                { question: 'Do we have to self-host?', answer: 'No. There is a managed version running in EU data centres if you want the outcome without the operations. Self-hosting is what makes the strongest version of the claim available to you — it is not a requirement for using the product.' },
                { question: 'What about our existing conversations?', answer: 'They stay where they are; there is no importer for another vendor’s chat history. In practice teams start fresh, because the conversations worth keeping are usually the documents that came out of them, and those you can upload into a knowledge base on day one.' },
            ],
        }),
        b('cta', {
            title: 'Point it at the model you already pay for',
            lead: 'Bring your API key, run the workspace yourself, and send a prompt with a real customer name in it. Then look at what the provider actually received.',
            button: { label: 'Run it yourself', link: pageLink('self-hosting') },
            secondaryCta: { label: 'How sovereignty works', link: pageLink('sovereignty') },
            showMotif: true,
            backgroundVariant: 'dark',
        }),
    ],
};

// ── Gemini for Workspace ────────────────────────────────
const geminiAlternative = {
    slug: 'gemini-alternative',
    title: 'Bee Flow vs Gemini for Workspace',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'A Gemini for Workspace alternative, model open | Bee Flow',
        metaDescription: 'The deepest Google Workspace integration we ship — Gmail, Drive, Docs, Sheets, Calendar — with the model left open and the workspace self-hostable.',
        ogImage: og('compare'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Comparison',
            badge: { enabled: true, text: 'Google Workspace is our deepest integration', icon: 'Scale' },
            titleParts: [{ text: 'Same Google apps. The model stays your choice', gradient: false }],
            lead: 'Connect the same Google Workspace — Gmail, Calendar, Drive, Docs, Sheets, Contacts, Meet recordings; it is the deepest integration we ship — and keep the model a setting rather than a property of the suite, Gemini included, through Google AI Studio or Vertex. Inside Docs and Gmail, Google wins on convenience and will keep winning. Beside them you get one workspace that spans more than one vendor’s apps, and a privacy layer sitting between the two.',
            primaryCta: { enabled: true, label: 'See the integrations', style: 'primary', link: pageLink('integrations') },
            secondaryCta: { enabled: true, label: 'All comparisons', style: 'secondary', link: pageLink('compare') },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'classic',
            media: media('', ''),
        }),
        b('features', {
            eyebrow: 'Where the two differ',
            title: 'Inside the apps, or beside them',
            variant: 'bento',
            items: [
                {
                    icon: 'Sparkles', span: 2,
                    title: 'Where Gemini for Workspace is ahead',
                    body: 'Being right there in the document. Nothing beats a sidebar in the file you already have open, and for drafting in Docs or summarising a thread in Gmail the integration is as tight as it gets because Google builds both halves. If your organisation is entirely on Google and the data question is settled, that convenience is real and difficult to match from outside.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Cpu', span: 1,
                    title: 'The model is not fixed to the suite',
                    body: 'Run Gemini if you want it — Google AI Studio and Vertex adapters both ship. Or Claude, or GPT, or Mistral, or a local model. Different assistants can use different models, and switching is a setting rather than a change of vendor.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Layers', span: 1,
                    title: 'It spans more than one vendor’s apps',
                    body: 'The same assistant reads Google Workspace, Microsoft 365, Nextcloud and your ITSM. Work does not usually sit in one suite, and an assistant confined to one of them can only ever see part of the picture.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Shield', span: 2,
                    title: 'A privacy layer between the suite and the model',
                    body: 'Install the detector and personal data from a document or a thread is tokenised on your own hardware before any prompt leaves for a provider, and restored in the answer. When the model is on your own network, nothing leaves at all. That layer sits outside the suite, which is exactly why it can apply to every suite you connect.',
                    techTag: '', media: media('', ''),
                },
            ],
        }),
        b('content', {
            columnLayout: '2',
            columns: [
                {
                    id: 'col_gem_reach',
                    elements: [{
                        id: 'el_gem_reach', kind: 'text', align: 'left',
                        heading: 'How deep the Google integration actually goes',
                        subheading: '',
                        body: 'Gmail, Calendar, Drive, Docs, Sheets, Slides, Contacts, Groups, Keep and Maps — ten Google services, and Meet recordings are ingested into meeting notes with transcription and speaker identification. Each person connects their own account by OAuth and an integration acts as the person who authorised it, so an assistant can never read a mailbox its user could not open themselves. This is our most complete connector set, not an afterthought.',
                    }],
                },
                {
                    id: 'col_gem_why',
                    elements: [{
                        id: 'el_gem_why', kind: 'text', align: 'left',
                        heading: 'Why a European organisation might want the separation',
                        subheading: '',
                        body: 'When the suite, the model and the workspace are one vendor, every question about processing has the same answer and you cannot change one part without changing all of it. Splitting them means you can keep Google Workspace as your office suite and still decide, separately, which model sees which data and in which country — including deciding that some categories never leave your own network. That separation is the product.',
                    }],
                },
            ],
        }),
        b('steps', {
            eyebrow: 'Trying it',
            title: 'Three steps to a fair comparison',
            variant: 'chapters',
            items: [
                {
                    number: '1',
                    title: 'Connect one Google account',
                    body: 'OAuth on your own credentials, nothing org-wide by default. Ask an assistant something about your own Drive and your own inbox and judge the answer against what you would get in the sidebar.',
                    example: 'Gmail · Drive · Docs · Sheets · Calendar · Meet recordings',
                    media: media('', ''),
                },
                {
                    number: '2',
                    title: 'Switch the model and ask again',
                    body: 'Change the assistant from Gemini to Claude, or to a model on your own network, and run the same question. Nothing about the assistant, its knowledge or its tools has to be rebuilt — that portability is the thing a single-vendor suite cannot offer.',
                    example: 'Gemini → Claude → local Qwen · same assistant',
                    media: media('', ''),
                },
                {
                    number: '3',
                    title: 'Send something with a real name in it',
                    body: 'With the detector installed, watch what the provider actually receives. That is the comparison in one step: not which model writes better, but what left your organisation to get the answer.',
                    example: 'tokenise on the way out · restore in the reply',
                    media: media('', ''),
                },
            ],
        }),
        b('trust-band', {
            variant: 'detailed',
            eyebrow: 'Honest boundaries',
            title: 'What this comparison does not claim',
            chips: [
                { icon: 'FileText', label: 'No sidebar inside Docs or Gmail', sublabel: 'Bee Flow works beside the Google apps through their APIs, not as an in-document panel. If that panel is the point for you, Gemini wins.', href: '' },
                { icon: 'Sparkles', label: 'Gemini is a good model', sublabel: 'You can run it here. Nothing on this page argues the model is the weak part — the comparison is the workspace around it.', href: '' },
                { icon: 'KeyRound', label: 'Google SSO is supported', sublabel: 'Sign in with Google works. Moving does not mean unpicking your identity provider.', href: '' },
                { icon: 'Server', label: 'Self-hosting is optional', sublabel: 'A managed EU-hosted version exists. Self-hosting is what makes the strongest claim available, not a requirement.', href: '' },
            ],
        }),
        b('faq', {
            eyebrow: 'Questions',
            title: 'What Google Workspace teams ask',
            items: [
                { question: 'Do we have to leave Google Workspace?', answer: 'No, and most teams do not. Google Workspace is the deepest integration Bee Flow ships — ten services — so it sits beside your suite rather than replacing it. The suite stays your office; Bee Flow becomes the layer where AI, automations and knowledge live.' },
                { question: 'Can we use Gemini as the model?', answer: 'Yes. Both the Google AI Studio and the Google Vertex adapters ship, so you can keep Gemini and change only where the workspace runs. That is a common configuration and a completely reasonable one.' },
                { question: 'Does it work inside Docs and Gmail?', answer: 'No. Bee Flow talks to those apps through their APIs — reading a thread, filing a document, updating a sheet — but there is no in-document sidebar. If your main use is drafting inside the document you already have open, that is a real gap and you should weigh it.' },
                { question: 'What about Meet recordings?', answer: 'They are ingested into meeting notes: transcription with speaker diarisation, and per-person voiceprints for identification where you have enrolled them. That runs on your own WhisperX service when you self-host, so the audio does not have to leave your infrastructure.' },
                { question: 'How do we keep some data away from any provider?', answer: 'Point the assistants that touch it at a local model — Ollama, vLLM or any OpenAI-compatible endpoint on your own network — and no prompt from those assistants reaches a cloud provider. Local models are recognised and the detector skips them; anything unknown is treated as external and inspected.' },
            ],
        }),
        b('cta', {
            title: 'Connect one Google account and compare',
            lead: 'Ten Google services, your own documents, and a model you pick. Fifteen minutes will tell you whether the separation is worth it for your organisation.',
            button: { label: 'See the integrations', link: pageLink('integrations') },
            secondaryCta: { label: 'How sovereignty works', link: pageLink('sovereignty') },
            showMotif: true,
            backgroundVariant: 'dark',
        }),
    ],
};

// ── Claude Team ──────────────────────────────────────
//
// The most delicate of the three: Claude is the DEFAULT provider in several
// places in the product and @anthropic-ai/sdk is a direct dependency. This
// page must read as "we run Claude and think it is excellent" or it is simply
// not credible.
const claudeAlternative = {
    slug: 'claude-alternative',
    title: 'Bee Flow vs Claude Team',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'A self-hosted Claude Team alternative | Bee Flow',
        metaDescription: 'Run the same Claude models in a workspace you host, with PII removed before the prompt leaves and one audit trail across chat, automations and apps.',
        ogImage: og('compare'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Comparison',
            badge: { enabled: true, text: 'We run Claude too', icon: 'Scale' },
            titleParts: [{ text: 'Keep Claude. Change the building it runs in', gradient: false }],
            lead: 'Point it at the same Claude — we ship an Anthropic adapter and Claude is the default in several places in this product — and change the building it runs in: conversations under a key you hold, Anthropic never receiving the customer’s name, and an escape hatch to a model on your own network for the work that should not leave it. We think Claude is excellent and nothing here argues otherwise. The comparison is between a hosted team workspace and one you can hold: who keeps the conversations, whether personal data reaches the provider, and whether the chat is the whole product or one surface among several.',
            primaryCta: { enabled: true, label: 'Open the app', style: 'primary', link: appLink('/app') },
            secondaryCta: { enabled: true, label: 'All comparisons', style: 'secondary', link: pageLink('compare') },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'classic',
            media: media('', ''),
        }),
        b('content', {
            columnLayout: '2',
            columns: [
                {
                    id: 'col_cl_fair',
                    elements: [{
                        id: 'el_cl_fair', kind: 'text', align: 'left',
                        heading: 'Where Claude Team is ahead',
                        subheading: 'Stated without hedging',
                        body: 'The chat product itself. Anthropic ships model capabilities to their own surface first, the interface is unusually well judged, and features like Projects and Artifacts are polished in a way that takes years. If what your team needs is the best possible Claude experience and there is no constraint on where conversations are processed, buying it directly from the people who make the model is a sensible decision and we would say so to your face.',
                    }],
                },
                {
                    id: 'col_cl_diff',
                    elements: [{
                        id: 'el_cl_diff', kind: 'text', align: 'left',
                        heading: 'What changes when the workspace is yours',
                        subheading: '',
                        body: 'Three things a hosted workspace cannot give you, whoever runs it. The conversations sit in a database you control, encrypted under a key derived from the user’s own password. Personal data can be removed before the prompt ever reaches Anthropic, by a detector on your own hardware. And the model becomes a setting: Claude for most work, a local model for anything you have decided must never leave the building, chosen per assistant rather than per subscription.',
                    }],
                },
            ],
        }),
        b('features', {
            eyebrow: 'What you gain',
            title: 'Four things that follow from holding the workspace',
            variant: 'bento',
            items: [
                {
                    icon: 'Cpu', span: 2,
                    title: 'The same Claude, plus an escape hatch',
                    body: 'Bring your Anthropic API key and the models behave exactly as they do today. What you gain is the option to route differently: a local model for the assistant that handles HR cases, Claude for everything else, and the freedom to change either without rebuilding a single assistant. Provider independence is only valuable at the moment you need it, which is why it has to be there beforehand.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Shield', span: 1,
                    title: 'Anthropic never has to see the name',
                    body: 'Install the detector and personal data is tokenised on your own CPU before the request leaves, then restored in the reply you read. The model does the work; the identifiers stay home. If the detector is installed and unreachable, the request fails closed rather than going out unchecked.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Lock', span: 1,
                    title: 'Conversations under your own key',
                    body: 'Chat and notebook conversations are encrypted with a key derived from the user’s password using Argon2id, and an OPAQUE path is available so a migrated account’s password never reaches the server. Knowledge documents and transcripts are server-readable, because search has to read them.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Workflow', span: 2,
                    title: 'Chat is one surface, not the product',
                    body: 'The same workspace runs workflows with approval gates and dry runs, internal apps over your own data model, meeting transcription with speaker identification, and cited answers over your own documents — sharing one permission model and one audit trail. A conversation can start a workflow, and the whole chain shows up in one place.',
                    techTag: '', media: media('', ''),
                },
            ],
        }),
        b('steps', {
            eyebrow: 'Evaluating',
            title: 'Prove the difference in one afternoon',
            variant: 'chapters',
            items: [
                {
                    number: '1',
                    title: 'Bring your own Anthropic key',
                    body: 'Start the stack, paste the key, pick a Claude model. Nothing about the model changes, which is the point — you are isolating the variable you actually care about.',
                    example: 'Provider → Anthropic → your key',
                    media: media('', ''),
                },
                {
                    number: '2',
                    title: 'Send a prompt with a real customer name in it',
                    body: 'With the detector installed, read the guardrail event afterwards: which category was detected, which direction, what action was taken — and never the matched content itself, because an audit log that copies the sensitive text is a second leak.',
                    example: 'detected: person, IBAN · action: tokenise · restored in reply',
                    media: media('', ''),
                },
                {
                    number: '3',
                    title: 'Point one assistant at a local model',
                    body: 'Connect Ollama or vLLM on your own network and move the assistant that handles your most sensitive category onto it. Nothing that assistant sees reaches any cloud provider. That configuration is the whole argument, and it takes about ten minutes.',
                    example: 'Provider → OpenAI-compatible → http://your-model:8000/v1',
                    media: media('', ''),
                },
            ],
        }),
        b('faq', {
            eyebrow: 'Questions',
            title: 'The obvious ones',
            items: [
                { question: 'Wait — you use Claude yourselves?', answer: 'Yes. The Anthropic SDK is a direct dependency and Claude is the default model in several parts of the product. That is exactly why this page compares workspaces rather than models: arguing that Claude is the weak point would contradict our own build, and you would notice.' },
                { question: 'So what are we actually buying?', answer: 'The layer around the model. Your own database for the conversations, encryption under a key the server cannot derive on its own, a PII detector running on your hardware, an egress log resolved to a country, and a workspace where the chat sits next to automations, knowledge and meeting notes rather than being the whole thing.' },
                { question: 'Is the chat as good as Anthropic’s own?', answer: 'No — not as a pure chat product. They build the model and the interface together and it shows. If chat quality is the only axis that matters to your team, buy it from them. The trade is everything in the previous answer.' },
                { question: 'Can we use Claude through Bedrock or Vertex?', answer: 'The adapters that ship are Anthropic direct, Azure OpenAI, Google AI Studio, Google Vertex, OpenAI and Mistral, plus any OpenAI-compatible endpoint. Check the provider list against your exact routing requirement before committing — we would rather you verified that than took our word for it.' },
                { question: 'Do we lose Projects and Artifacts?', answer: 'Those specific features, yes — they are Anthropic\'s product. The nearest equivalents here are notebooks with cited sources over your own documents, and assistants with memory scoped to a user or a project. Different shape, and worth trying before you assume it maps.' },
                { question: 'Is this open source?', answer: LICENCE_ANSWER },
            ],
        }),
        b('cta', {
            title: 'Run the same model somewhere else and compare',
            lead: 'Bring your key, start the stack, and send the prompt you would never paste into a hosted chat window. That is the only comparison that settles it.',
            button: { label: 'Run it yourself', link: pageLink('self-hosting') },
            secondaryCta: { label: 'How sovereignty works', link: pageLink('sovereignty') },
            showMotif: true,
            backgroundVariant: 'dark',
        }),
    ],
};


// ── Demo-led feature pages ─────────────────────────────────
// Same factory as /assistants and /automations. Block sequences differ per page
// because two pages sharing one is a test failure - and because the questions
// a visitor brings to "skills" and to "monitoring" are not the same shape.

const skillsPage = demoPage({
    slug: 'skills',
    title: 'Skills',
    metaTitle: 'Reusable AI skills \u2014 write the guidance once | Bee Flow',
    metaDescription: 'A skill is instructions, rules and worked examples an assistant pulls in on demand. Write your house style once, publish it to a group. Try the editor.',
    ogImage: og('feature'),
    eyebrow: 'Skills',
    headline: 'Write the guidance once, not in every assistant',
    gradientTail: '',
    lead: 'Every team ends up with the same paragraph pasted into six assistants: how we write, what we never promise, which checks a draft has to pass. A skill is that paragraph made into an object \u2014 versioned, shared with the groups you choose, and pulled in only when it is relevant.',
    secondaryCta: { label: 'See the platform', link: pageLink('platform') },
    feature: 'skills',
    demoTitle: 'Open a skill and read what is in it',
    demoLead: 'Six sample skills: a house writing style, tender triage, an incident write-up format, Dutch business correspondence, a contract-review checklist and a weekly digest. Edit one \u2014 nothing is saved.',
    note: 'Sample skills only. The demo has no network access, so edits are discarded on reload.',
    body: [
        b('features', {
            eyebrow: 'What a skill holds',
            title: 'Four parts, and the third is the one people skip',
            variant: 'classic',
            items: [
                { icon: 'FileText', span: 1, title: 'Instructions', body: 'The prose an assistant reads before it answers. Written once, in one place, so correcting it corrects every assistant that uses it.', techTag: '', media: media('', '') },
                { icon: 'ListChecks', span: 1, title: 'Rules', body: 'Short, checkable constraints \u2014 no exclamation marks, never promise an unconfirmed date. Rules are where a house style stops being a suggestion.', techTag: '', media: media('', '') },
                { icon: 'MessageSquareQuote', span: 1, title: 'Worked examples', body: 'An input and the output you wanted. This is the part teams leave empty and then wonder why the tone drifts \u2014 a model matches examples far more reliably than it follows adjectives.', techTag: '', media: media('', '') },
                { icon: 'Zap', span: 1, title: 'When to activate', body: 'Keywords that make a skill load only when the conversation is actually about that work, so an assistant is not carrying six irrelevant rulebooks into every reply.', techTag: '', media: media('', '') },
            ],
        }),
        b('content', {
            columnLayout: '2',
            columns: [
                {
                    id: 'col_sk_share',
                    elements: [{
                        id: 'el_sk_share', kind: 'text', align: 'left',
                        heading: 'Shared to a group, not to everyone',
                        subheading: '',
                        body: 'A skill starts personal. Publish it to a group and the people in that group get it \u2014 support gets the tone rules, legal gets the clause checklist, and nobody inherits guidance written for someone else\u2019s job. The permission model is the same one the rest of the workspace uses, so there is nothing new to administer.',
                    }],
                },
                {
                    id: 'col_sk_why',
                    elements: [{
                        id: 'el_sk_why', kind: 'text', align: 'left',
                        heading: 'Why this is not just a longer prompt',
                        subheading: '',
                        body: 'A long prompt is copied, and copies drift. Six assistants with the house style pasted in become six slightly different house styles within a quarter, and nobody notices until a customer does. Making it an object means there is one to change, one to review, and one to point at when someone asks why the wording is what it is.',
                    }],
                },
            ],
        }),
    ],
    faq: [
        { question: 'How is a skill different from a knowledge base?', answer: 'A knowledge base is material the assistant reads to find facts. A skill is guidance on how to behave \u2014 tone, format, what to check before answering. Most useful assistants have both: the knowledge to answer, and the skill to answer the way you would.' },
        { question: 'Can an assistant use more than one?', answer: 'Yes, and most do. Activation keywords keep it sane \u2014 a skill loads when the conversation is about that work rather than being carried into every reply.' },
        { question: 'Who can edit them?', answer: 'Whoever you share them with as an editor. Because a skill is shared rather than copied, an edit reaches every assistant using it, which is the point and also the reason to be deliberate about who holds the pen.' },
    ],
    closing: {
        title: 'Write one and see how far it travels',
        lead: 'Start with the paragraph you have already pasted into three assistants. That one is always the best first skill.',
    },
});

const knowledgePage = demoPage({
    slug: 'knowledge',
    title: 'Knowledge bases',
    metaTitle: 'Self-hosted RAG with cited answers | Bee Flow',
    metaDescription: 'Index handbooks, product docs and legal sources, scope them per group, and get answers that cite the passage they came from. Hybrid search, self-hosted.',
    ogImage: og('feature'),
    eyebrow: 'Knowledge bases',
    headline: 'Answers that cite the document they came from',
    gradientTail: '',
    lead: 'A knowledge base is the material your assistants are allowed to read: the handbook, the product documentation, the tender answers you have already written, the sources your sector runs on. Scoped per group, counted so you can see what retrieval is working with, and stored in a database you can back up and export.',
    secondaryCta: { label: 'How sovereignty works', link: pageLink('sovereignty') },
    feature: 'knowledge',
    demoTitle: 'The knowledge layer, as an admin sees it',
    demoLead: 'Seven sample bases across four categories, with the document counts that drive retrieval. This is the management view \u2014 the part you set up once and then mostly forget.',
    note: 'Sample knowledge bases. No documents are included and nothing is uploaded \u2014 the demo has no network access.',
    body: [
        b('steps', {
            eyebrow: 'How a document becomes an answer',
            title: 'Four steps, and you can inspect every one',
            variant: 'chapters',
            items: [
                { number: '1', title: 'Ingest and chunk', body: 'A document is split into passages sized for retrieval rather than for reading. Chunking is token-aware, so a passage does not end mid-sentence and lose the context that made it findable.', example: 'PDF, DOCX, Markdown, HTML, plain text', media: media('', '') },
                { number: '2', title: 'Embed and index', body: 'Each passage gets a vector in your own PostgreSQL, using pgvector. The index lives with your data rather than in a search vendor\u2019s cloud.', example: 'pgvector, in your own database', media: media('', '') },
                { number: '3', title: 'Retrieve and rerank', body: 'A question pulls candidate passages, and a cross-encoder reorders them by how well they actually answer it. Reranking runs on CPU, so this does not require a GPU box.', example: 'retrieve \u2192 rerank \u2192 top passages', media: media('', '') },
                { number: '4', title: 'Answer with citations', body: 'The answer names the passages it used. That is the difference between a system you can check and one you have to trust \u2014 and the reason a wrong answer is recoverable rather than mysterious.', example: 'every claim traceable to a source', media: media('', '') },
            ],
        }),
        b('features', {
            eyebrow: 'Control',
            title: 'Who can read what, decided once',
            variant: 'classic',
            items: [
                { icon: 'Users', span: 1, title: 'Scoped per group', body: 'A base is visible to the groups you choose. An assistant reading it can never surface a passage to someone who could not open the document themselves.', techTag: '', media: media('', '') },
                { icon: 'Layers', span: 1, title: 'Grouped by category', body: 'Internal, product, commercial, legal. Categories keep the list navigable once an organisation has thirty bases rather than three.', techTag: '', media: media('', '') },
                { icon: 'Download', span: 1, title: 'Exports to a file', body: 'A base exports on demand in an open format. Handing your own material to an auditor should not require giving them an account.', techTag: '', media: media('', '') },
            ],
        }),
        b('trust-band', {
            variant: 'detailed',
            eyebrow: 'Worth knowing',
            title: 'Where the boundary sits',
            chips: [
                { icon: 'Database', label: 'Documents are server-readable', sublabel: 'Search has to read them, so knowledge bases are not covered by the zero-knowledge encryption that protects chat and notebooks. We would rather name that than let the strongest claim cover everything.', href: '' },
                { icon: 'Cpu', label: 'Embedding can run locally', sublabel: 'Point it at a local embedding model and the passages never reach a provider at all.', href: '' },
                { icon: 'Gauge', label: 'Retrieval quality is measurable', sublabel: 'Reranking is a real cross-encoder, not a similarity score with a nicer name \u2014 you can compare the two on your own material.', href: '' },
            ],
        }),
    ],
    faq: [
        { question: 'What formats can we index?', answer: 'PDF, Word, Markdown, HTML and plain text, plus pages pulled from the systems you connect. Scanned documents need to carry a text layer \u2014 there is no OCR step in the ingest path.' },
        { question: 'Where do the embeddings live?', answer: 'In your own PostgreSQL, using pgvector. There is no separate vector database to run and no search vendor holding a copy of your material.' },
        { question: 'Can we keep a base away from a cloud model?', answer: 'Yes. Point the assistants that read it at a local model and no passage reaches a provider. That configuration is why the embedding and reranking services are built to run on CPU.' },
        { question: 'How big can a base get?', answer: 'Large enough that disk is the practical limit rather than the index. Plan for the storage the documents themselves need; the vectors are small next to the source material.' },
    ],
    closing: {
        title: 'Index one folder and ask it something',
        lead: 'The test worth running is a question you already know the answer to, on material you already trust. The citations tell you whether retrieval found the right passage.',
    },
});

const monitoringPage = demoPage({
    slug: 'monitoring',
    title: 'Usage monitoring',
    metaTitle: 'AI usage and cost monitoring per model | Bee Flow',
    metaDescription: 'See AI usage across models, assistants, people and tools, with cost per model and a local model at zero \u2014 the report that shows where your AI spend went.',
    ogImage: og('feature'),
    eyebrow: 'Monitoring',
    headline: 'What your organisation actually spent, and on which model',
    gradientTail: '',
    lead: 'Most AI spend is invisible until the invoice arrives, and by then the interesting question \u2014 which model saw which data \u2014 is unanswerable. This is the reporting layer: usage by model, assistant, person and tool, with cost attached and an egress trail behind it.',
    secondaryCta: { label: 'How sovereignty works', link: pageLink('sovereignty') },
    feature: 'monitoring',
    demoHeight: 980,
    demoTitle: 'A week of usage for a small team',
    demoLead: 'Totals, a daily timeline, and breakdowns by model, assistant, person and tool. The row worth looking at is the local model: real traffic, zero provider cost, nothing that left the network.',
    note: 'Synthetic figures, and they reconcile \u2014 per-model calls sum to the total and the timeline sums to the same number. Sample data only.',
    body: [
        b('techStats', {
            eyebrow: '',
            title: 'What it breaks usage down by',
            stats: [
                { number: '4', label: 'dimensions: model, assistant, person, tool' },
                { number: '2', label: 'cost views: estimated and billed' },
                { number: '0', label: 'provider cost on a locally hosted model' },
                { number: '1', label: 'place the whole organisation is visible' },
            ],
        }, { band: 'dark' }),
        b('features', {
            eyebrow: 'What you can answer with it',
            title: 'Three questions that are usually guesswork',
            variant: 'classic',
            items: [
                { icon: 'Coins', span: 1, title: 'What is this costing, per model?', body: 'Cost tracks tokens at each model\u2019s own rate, so switching an assistant from an expensive model to a cheaper one shows up as a number rather than a feeling.', techTag: '', media: media('', '') },
                { icon: 'Users', span: 1, title: 'Who is actually using it?', body: 'Per-person and per-assistant breakdowns tell you whether a rollout landed or whether four people are carrying it. That is a adoption question, and it is usually answered with anecdotes.', techTag: '', media: media('', '') },
                { icon: 'Globe2', span: 1, title: 'Where did the data go?', body: 'Every integration call is resolved to a country at log time and non-EEA transfers are flagged, so the answer is a report rather than an assurance.', techTag: '', media: media('', '') },
            ],
        }),
        b('content', {
            columnLayout: '2',
            columns: [
                {
                    id: 'col_mon_local',
                    elements: [{
                        id: 'el_mon_local', kind: 'text', align: 'left',
                        heading: 'The local-model row is the argument',
                        subheading: '',
                        body: 'In the sample data one model carries roughly a quarter of the traffic at zero provider cost, because it runs on the organisation\u2019s own hardware. That is not a demo trick \u2014 it is what the reporting looks like once you route the sensitive work to a model on your own network. The saving is real, but the reason to do it is that those prompts never left the building.',
                    }],
                },
                {
                    id: 'col_mon_privacy',
                    elements: [{
                        id: 'el_mon_privacy', kind: 'text', align: 'left',
                        heading: 'Monitoring that is not itself a leak',
                        subheading: '',
                        body: 'Usage records carry the shape of activity, not its content: which model, how many tokens, how long, which tool. Guardrail events record the category and the action taken and never the matched text. A monitoring layer that copied prompts into a log would be creating the exposure it is meant to measure, which is why it does not.',
                    }],
                },
            ],
        }),
    ],
    faq: [
        { question: 'Does the log contain our prompts?', answer: 'No. Usage records hold model, token counts, duration and tool names \u2014 the shape of the activity, not its content. Guardrail events record which category was detected and what was done, never the matched text.' },
        { question: 'Is the cost figure exact?', answer: 'It is an estimate from token counts at the model\u2019s published rate, shown alongside billed cost where the provider reports one. Treat it as a good working number for comparing assistants, not as an invoice.' },
        { question: 'Can we export it?', answer: 'Yes, and this is usually the point \u2014 the figures end up in a board pack or a DPIA. Ops metrics can also be pushed to your own observability stack rather than read from a screen.' },
        { question: 'Who can see it?', answer: 'Organisation administrators. It is a per-org view by design: an individual\u2019s usage is visible to the people accountable for the deployment, not to their colleagues.' },
    ],
    closing: {
        title: 'Run it for a fortnight and read the model column',
        lead: 'The first thing most teams find is one assistant on an expensive model doing work a cheap one would do just as well.',
    },
});

const compliancePage = demoPage({
    slug: 'compliance',
    title: 'Compliance Center',
    metaTitle: 'GDPR, EU AI Act and ISO 27001 checks | Bee Flow',
    metaDescription: '44 checks read your live configuration: 15 GDPR, 6 EU AI Act and 23 ISO 27001 — with a DSR inbox, breach register, RoPA and evidence bundles.',
    ogImage: og('security'),
    eyebrow: 'Compliance',
    heroBadge: 'In development - playable below',
    headline: 'Compliance measured against your install, ',
    gradientTail: 'not against a questionnaire',
    lead: 'Most compliance tooling asks you what you do and files the answer. This reads the configuration of the workspace you are actually running — where the models are, who can see what, whether the retention job runs, whether the logs are tamper-evident — and grades it. Where a thing genuinely cannot be checked from a machine, the check says so and asks a person to attest instead, and the score reports the two separately. The module is still in development: everything below is running, but it is not finished and the details will change before it is.',
    secondaryCta: { label: 'How sovereignty works', link: pageLink('sovereignty') },
    feature: 'compliance',
    // Taller than the usual 760: a left framework rail, a score ring, four
    // counters, a trend chart and the open-items table before a visitor has
    // clicked anything.
    demoHeight: 980,
    demoEyebrow: 'Live demo · in development',
    demoTitle: 'A fictional broker, eight months into an ISMS',
    demoLead: 'Van Dael Assurantiën exists only here. Switch between the privacy frameworks and ISO 27001 on the left, open a failing check to see what it read, work through the DSR inbox, look at the breach register, or open the Statement of Applicability and read a control exclusion.',
    note: 'This module is still in development: it is real and running, but it is not finished and the details will change. Sample organisation, sample findings. The checks are the real ones and the Annex A catalogue is the real one; the results are invented, nothing is saved, and the PDF exports are switched off because the demo has no server behind it.',
    body: [
        b('steps', {
            eyebrow: 'How it works',
            title: 'Four things, in the order they actually happen',
            variant: 'chapters',
            items: [
                {
                    number: '1', title: 'It reads what you are running', example: '',
                    body: 'The scan queries your own installation: which providers are configured and in which region, whether encryption at rest is on, who holds administrative permissions, whether the retention job is scheduled, whether outbound calls are resolved to a country at log time. Nothing is uploaded anywhere to be assessed — the checks execute where the data already is, which is the only way the answer can be about you rather than about a form you filled in.',
                    media: media('', ''),
                },
                {
                    number: '2', title: 'It separates fact from attestation', example: '',
                    body: 'Some obligations cannot be verified by software. Whether your privacy notice is accurate, whether staff have had AI literacy training, whether a supplier agreement is signed — those are human statements, and the hub records them as attestations with a date and a person against them. The overview shows the split rather than blending the two, because a score that presents self-declarations as verified facts is worse than no score.',
                    media: media('', ''),
                },
                {
                    number: '3', title: 'It holds the registers, not just the score', example: '',
                    body: 'A score on its own is not evidence. Behind it sit the artefacts a regulator or an auditor asks for: the data-subject request inbox with its statutory clock, the breach register that starts a 72-hour authority deadline the moment an incident is recorded, the record of processing activities assembled from what is actually deployed, a DPIA per assistant, and for ISO the Statement of Applicability, the ISMS policy set, the risk register, the internal audit and the training attestations.',
                    media: media('', ''),
                },
                {
                    number: '4', title: 'It leaves a trail you can hand over', example: '',
                    body: 'Every check run writes a hashed evidence record, every register exports as a PDF, and the whole evidence set packs into a bundle you hand over as one file. Ten evidence connectors extend the reach beyond the workspace itself, reading the systems an ISMS actually spans — Google Workspace, Microsoft Entra, Nextcloud, GitHub, your TLS endpoints, mail security, monitoring — so the trail covers the estate, not just this product. The point is not the export button: the document you hand an auditor was generated from the same configuration the systems are running on, on a date the trail can prove, rather than assembled by hand from memory the week before the audit.',
                    media: media('', ''),
                },
            ],
        }),
        b('content', {
            columnLayout: '2',
            columns: [
                {
                    id: 'col_comp_not',
                    elements: [{
                        id: 'el_comp_not', kind: 'text', align: 'left',
                        heading: 'What this is not',
                        subheading: '',
                        body: 'It is not a certificate, and it does not make you compliant. No auditor has signed off on how we map a check to an article, no certification body is involved, and a high score is a statement about your configuration rather than about your organisation. What the tool removes is the part that is genuinely mechanical — finding out what the software is currently doing, and keeping the registers current — so the judgement work is left with the people qualified to do it. If you want the reverse of that arrangement, this is the wrong product.',
                    }],
                },
                {
                    id: 'col_comp_scope',
                    elements: [{
                        id: 'el_comp_scope', kind: 'text', align: 'left',
                        heading: 'Why the frameworks share a hub',
                        subheading: '',
                        body: 'GDPR, the EU AI Act and ISO 27001 ask overlapping questions about the same installation. Where your models run answers a transfer question under one, a residency question under another, and a supplier control under the third. Running them as three separate exercises means gathering the same evidence three times and getting three slightly different answers. Here the evidence is collected once and read by each framework in its own terms, with the Annex A controls cross-referenced to the automated checks that evidence them.',
                    }],
                },
            ],
        }),
        b('techStats', {
            eyebrow: 'Scope',
            title: 'What is in the box',
            stats: [
                { number: '44', label: 'checks across GDPR, the EU AI Act and ISO 27001' },
                { number: '93', label: 'Annex A controls in the Statement of Applicability' },
                { number: '72h', label: 'authority clock, started when an incident is recorded' },
                { number: '0', label: 'data leaves your installation to be assessed' },
            ],
        }, { band: 'dark' }),
    ],
    faq: [
        { question: 'What status is this at?', answer: 'In development, and the roadmap says the same in the same words. It is enterprise-plan and reachable today for an administrator with the compliance permission — real code you can use, not finished. Evaluate it on that basis.' },
        { question: 'Does anything leave our installation?', answer: 'No. The checks run inside your own deployment and read your own configuration; the score, the registers and the evidence records are stored in your database. There is no assessment service to send anything to, which is also why the result is specific to you rather than to a category you were sorted into.' },
        { question: 'Are the ISO 27001 control texts included?', answer: 'The control references and our own descriptions of them are, and the Statement of Applicability is built around the Annex A structure. The standard’s text itself is copyright ISO and is not reproduced — you need your own copy, as you would for any ISO work.' },
        { question: 'Can it fix what it finds?', answer: 'Some of it. Where a finding maps to a setting the product owns, the check offers to change it and records that it did. Most findings do not work that way, and for those the check links to the screen where the decision is made rather than pretending it can make it for you.' },
        { question: 'Who can see this?', answer: 'An administrator holding the compliance permission. It is deliberately a separate permission from general organisation administration, because the person who runs your privacy programme is often not the person who runs your workspace, and neither should have to become the other to do their job.' },
    ],
    closing: {
        title: 'Point it at your own installation and read the red rows first',
        lead: 'The first scan usually finds two or three things nobody had got to yet. That is the useful outcome — a scan that finds nothing is a scan that was not really looking.',
    },
});

const appStudioPage = demoPage({
    slug: 'app-studio',
    title: 'App Studio',
    metaTitle: 'Build internal apps with AI — App Studio | Bee Flow',
    metaDescription: 'Describe the tracker, intake form or dashboard you need and the AI builds it: screens, a private database, sample rows and working actions. Try the editor.',
    ogImage: og('feature'),
    eyebrow: 'App Studio',
    heroBadge: 'In development - playable below',
    headline: 'The internal tools your team keeps asking for, ',
    gradientTail: 'described instead of built',
    lead: 'Every team runs on a handful of small tools somebody once promised to build: the tracker, the intake form, the planning board. App Studio builds them inside your workspace, over their own private database, with access rules per row — you describe what you need and the AI designs the data model, seeds it, and wires the screens, or you skip the AI entirely and drag components yourself. The module is usable today and still moving: everything below is running, but details will change before it is finished.',
    secondaryCta: { label: 'Community vs Enterprise', link: pageLink('editions') },
    feature: 'app-studio',
    // Taller than the usual 760: the editor carries a header, screen tabs, a
    // component ribbon and the AI-builder pane before the canvas begins.
    demoHeight: 980,
    demoEyebrow: 'Live demo · in development',
    demoTitle: 'A real app, open in the real editor',
    demoLead: 'A policy-renewal pipeline for Van Dael Assurantiën, the fictional insurance office all our demos share: three tables, seeded rows, and a kanban wired to them. Switch to Preview and drag a renewal to another stage, click a card to open its record, read the AI conversation that built the app, or open the version history in the header.',
    note: 'Sample app on sample data. The demo has no network access: nothing you type, drag or save leaves your browser, and the AI-builder pane answers with a script rather than a model.',
    body: [
        b('features', {
            eyebrow: 'What a built app is',
            title: 'A real application, not a form with a logo',
            variant: 'classic',
            items: [
                {
                    icon: 'Blocks', span: 'third', title: 'More than forty components', techTag: '',
                    body: 'Data grids, kanban boards, calendars, charts, forms, record detail pages, timelines and an AI chat surface — assembled on a twelve-column canvas. The screens in an app are the same React components this demo is rendering, not a preview of something that compiles later.',
                    media: media('', ''),
                },
                {
                    icon: 'Database', span: 'third', title: 'Its own private database', techTag: '',
                    body: 'Every app gets its own tables, up to a hundred thousand rows each, inside your installation. Relations, select fields, computed columns and saved queries live next to the screens that use them, and nothing is shared with other apps unless you publish it.',
                    media: media('', ''),
                },
                {
                    icon: 'ShieldCheck', span: 'third', title: 'Access rules per row', techTag: '',
                    body: 'Roles are part of the app, not an afterthought: who may read which rows, who may write them, which screens a role sees. A field agent and a team lead open the same app and get different data, enforced when the query runs rather than hidden in the interface.',
                    media: media('', ''),
                },
                {
                    icon: 'Rocket', span: 'third', title: 'Publish with a paper trail', techTag: '',
                    body: 'Publish to the whole organisation or to named groups. Readers get a frozen published version while you keep editing the draft, and a snapshot history lets you put any earlier version back with one click.',
                    media: media('', ''),
                },
            ],
        }),
        b('showcase', {
            variant: 'code-ui',
            eyebrow: 'Under the hood',
            title: 'Structured definitions, never generated code',
            lead: 'The AI does not write code that you then have to trust. It emits an app definition — a validated document describing screens, components, data bindings and actions — and the same schema the visual editor enforces validates every AI change, repairs what it can and rejects what it cannot. This is the board from the demo above, as the definition actually stores it.',
            media: media('', ''),
            code: {
                language: 'json',
                snippet: '{\n  "type": "kanban",\n  "props": {\n    "source": { "kind": "records", "tableId": "tbl_renewals" },\n    "groupByField": "stage",\n    "columns": [\n      { "value": "proposal", "label": "Proposal sent" },\n      { "value": "won", "label": "Renewed" }\n    ]\n  },\n  "onCardMove": "act_move"\n}\n\n"act_move": {\n  "kind": "sequence",\n  "steps": [\n    { "kind": "update_record", "values": { "stage": "value" } },\n    { "kind": "toast", "message": "Renewal moved." },\n    { "kind": "refresh" }\n  ]\n}',
            },
        }),
        b('steps', {
            eyebrow: 'Build with AI',
            title: 'One conversation, four things it actually does',
            variant: 'chapters',
            items: [
                {
                    number: '1', title: 'It designs the data model', example: '',
                    body: 'Ask for a renewal pipeline and the first thing the builder does is not a screen — it is tables. Clients, contacts, renewals, the fields on each, the relations between them, and the select options a stage field needs. The model is yours afterwards: rename fields, add tables, tighten what is required.',
                    media: media('', ''),
                },
                {
                    number: '2', title: 'It seeds rows so nothing is empty', example: '',
                    body: 'A board with no cards looks broken, so the builder writes sample rows the moment the tables exist. You see the app the way your team will see it, then replace the samples with real data — typed in, pasted from a spreadsheet, or pulled through a connector from a system you already run.',
                    media: media('', ''),
                },
                {
                    number: '3', title: 'It wires screens, bindings and actions', example: '',
                    body: 'Components are bound to tables and queries, clicks are bound to actions: navigate to a detail screen, update the record a card was dropped on, run one of your Automations, show a toast. Twelve templates ship as starting points, and every one of them can be remixed into your own app.',
                    media: media('', ''),
                },
                {
                    number: '4', title: 'It dry-runs before it hands over', example: '',
                    body: 'Before a build lands, the definition is validated and dry-run: do the screens reference tables that exist, do the actions point at real records, does the whole thing load. Then you take over in the editor — by hand, or by continuing the conversation. Every AI turn is one undo step, and the version history keeps the trail.',
                    media: media('', ''),
                },
            ],
        }),
    ],
    faq: [
        { question: 'Do we have to use the AI?', answer: 'No. The AI builder and the visual editor edit the same definition, so you can describe the first version and refine it by hand, or build the whole thing yourself component by component. Teams that never touch the chat pane lose nothing except typing speed.' },
        { question: 'Where does an app’s data live?', answer: 'In the app’s own database inside your installation, next to everything else Bee Flow stores for you. Row-level access rules are enforced server-side when a query runs, and nothing in an app is readable by other apps or other organisations.' },
        { question: 'Who can open a published app?', answer: 'Whoever you publish it to: the whole organisation or named groups. Readers use the frozen published version while the owner keeps editing the draft, and everyone who opens an app needs a seat on the same installation — apps are internal tools, not public websites.' },
        { question: 'Which edition is this?', answer: 'Enterprise, and the editions page lists it as an enforced gate — the comparison there is generated from what the code actually checks. The module itself is in development: usable today, still changing shape, and the roadmap says the same in the same words.' },
    ],
    closing: {
        title: 'Describe the tool your team is missing',
        lead: 'The first app is usually the one somebody has been faking with a spreadsheet for a year. Describe it, look at what comes back, and keep the parts that are right.',
    },
});

const supportPage = demoPage({
    slug: 'support',
    title: 'Support inbox',
    metaTitle: 'A support inbox inside your AI workspace | Bee Flow',
    metaDescription: 'Shared mailboxes, statuses, assignment and tags, with assistants drafting replies grounded in your own knowledge base. Try it on eight sample tickets.',
    ogImage: og('feature'),
    eyebrow: 'Support',
    headline: 'A service desk that already knows your documentation',
    gradientTail: '',
    lead: 'Support is a surface of the workspace rather than another subscription: shared inboxes, statuses, assignment, tags and an audit trail \u2014 with assistants drafting replies from the same knowledge base your team already maintains. The draft is a starting point a human sends, never an answer that goes out on its own.',
    secondaryCta: { label: 'See the knowledge layer', link: pageLink('knowledge') },
    feature: 'support',
    demoTitle: 'Eight tickets, four statuses, one mailbox',
    demoLead: 'Filter by status, open a thread, change a priority, ask for a draft. The internal notes and the non-support bucket are both there, because a real inbox has both.',
    note: 'Sample tickets only. No mailbox is connected, nothing is sent, and the draft button assembles a canned reply rather than calling a model \u2014 it says so in the text it produces.',
    body: [
        b('features', {
            eyebrow: 'Why it lives here',
            title: 'The knowledge is already in the building',
            variant: 'classic',
            items: [
                { icon: 'BookOpen', span: 1, title: 'Drafts grounded in your own material', body: 'The assistant answers from the knowledge bases you already maintain for everything else, so support stops being a separate copy of the documentation that drifts out of date.', techTag: '', media: media('', '') },
                { icon: 'UserCheck', span: 1, title: 'A person still sends it', body: 'Drafts land in the composer for review. Nothing is auto-sent, because the ticket where an automated reply is wrong is exactly the ticket where it matters.', techTag: '', media: media('', '') },
                { icon: 'ScrollText', span: 1, title: 'One audit trail', body: 'Support actions land in the same trail as automations and admin changes, rather than in a second system somebody has to be given access to.', techTag: '', media: media('', '') },
            ],
        }),
        b('steps', {
            eyebrow: 'How a ticket moves',
            title: 'From an email to a resolved thread',
            variant: 'chapters',
            items: [
                { number: '1', title: 'Mail arrives and is triaged', body: 'A connected mailbox becomes a queue. Marketing and invoices get tagged out of the way so the awaiting-agent view is only work.', example: 'Gmail or Microsoft 365, OAuth per mailbox', media: media('', '') },
                { number: '2', title: 'An assistant drafts an answer', body: 'Grounded in the knowledge bases attached to that inbox, with the passages it used attached. If it has nothing to go on, it says so instead of improvising.', example: 'draft \u2192 review \u2192 edit \u2192 send', media: media('', '') },
                { number: '3', title: 'A person sends, and the trail records it', body: 'Status moves, the assignment stands, and the exchange stays in one place \u2014 including the internal notes, which the customer never sees.', example: 'awaiting agent \u2192 awaiting customer \u2192 resolved', media: media('', '') },
            ],
        }),
        b('media-text', {
            heading: 'What it is not',
            subheading: 'Said before you evaluate it',
            body: 'This is a team inbox with AI drafting, not a full ITSM platform. There is no CMDB, no change management and no customer-facing portal \u2014 if you need those, we integrate with Jira, ServiceNow, Zendesk, Freshservice and TopDesk rather than pretending to replace them. Support Inbox is enterprise, opt-in, and gated per member as well as per organisation.',
            cta: { label: 'See the integrations', link: pageLink('integrations') },
            media: media('', ''),
            mediaPosition: 'right',
            mediaSize: 'half',
            backgroundVariant: 'surface',
        }),
    ],
    faq: [
        { question: 'Does it reply to customers automatically?', answer: 'No. Drafts go to the composer and a person sends them. Auto-reply is the feature everyone asks for and then switches off after the first wrong answer reaches a customer.' },
        { question: 'Which mailboxes can we connect?', answer: 'Gmail and Microsoft 365 through OAuth, per mailbox. The integration acts as the account that authorised it, so it can never read more mail than that account could.' },
        { question: 'Does it replace our ITSM?', answer: 'No, and we would not suggest it. It is a shared inbox with drafting and an audit trail. For change management and a CMDB, keep the tool you have \u2014 five of them are built-in integrations.' },
        { question: 'Who can see the tickets?', answer: 'Access is per member as well as per organisation: someone needs the support permission on top of the licence. A colleague with a workspace account does not get the inbox by default.' },
    ],
    closing: {
        title: 'Point it at one mailbox and see what it drafts',
        lead: 'The useful test is a real question your documentation already answers. If the draft finds it, the rest follows.',
    },
});

// ── Identity & access ──────────────────────────────────────
//
// The identity story used to live in asides: a trust-band chip on /security
// phrased as an apology, "one permission model" said nine times and explained
// nowhere. This page is where it is spelled out — and where the boundary
// (no SAML, no SCIM, no generic IdP) is said plainly, because procurement
// asks in week one and finding out in week three costs the deal.
const identityAccess = {
    slug: 'identity-access',
    title: 'Identity & access',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'SSO, Entra ID group sync and roles | Bee Flow',
        metaDescription: 'OAuth SSO with Google, Microsoft Entra ID and Nextcloud, automatic group sync, six built-in roles plus custom roles, TOTP MFA and an access audit log.',
        ogImage: og('security'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Identity & access',
            badge: { enabled: true, text: 'SSO · group sync · roles', icon: 'KeyRound' },
            titleParts: [{ text: 'Sign in with the identity you already run', gradient: false }],
            lead: 'Bee Flow does not want to be your identity provider. It signs people in with OAuth against Google, Microsoft Entra ID — single-tenant or multi-tenant — or Nextcloud, mirrors your groups instead of asking anyone to rebuild them, and decides everything else with six built-in roles and a rights model that only ever grants, never silently widens. This page walks the whole chain: who gets in, which organisation they land in, what they can touch, and where that is written down when an auditor asks.',
            primaryCta: { enabled: true, label: 'Run it on your own tenant', style: 'primary', link: pageLink('self-hosting') },
            secondaryCta: { enabled: true, label: 'Security & encryption', style: 'secondary', link: pageLink('security') },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'classic',
            media: media('', ''),
        }),
        b('features', {
            eyebrow: 'The directory does the work',
            title: 'Your groups, mirrored — not maintained twice',
            lead: 'Access management fails at the second admin console. So Bee Flow reads the one you already run.',
            variant: 'bento',
            items: [
                {
                    icon: 'RefreshCw', span: 2,
                    title: 'Microsoft Entra ID groups, synced on a clock and at the door',
                    body: 'Switch on the periodic sync — six hours by default once enabled, and configurable — and it reads the groups assigned to the Bee Flow enterprise app and mirrors them here, members included. On top of that, a Microsoft sign-in re-checks that person against the groups already mirrored, so a membership change in Entra is reflected when they arrive rather than at the next interval; that login pass is also where removals land, because someone dropped from a group in Entra loses what the group granted. Deleting Azure-managed groups outright is a separate opt-in, so the sync cannot dismantle local structure by accident. On a plan with a seat limit, provisioning stops at that limit rather than silently exceeding it.',
                    techTag: 'periodic + re-checked at login', media: media('', ''),
                },
                {
                    icon: 'FolderSync', span: 1,
                    title: 'Nextcloud users and groups, mirrored live',
                    body: 'Webhooks mirror Nextcloud users and groups in near real time, with a six-hour reconciliation pass as the backstop for anything a webhook missed. Three modes per organisation: mirror everything, mirror selected groups, or manual. Nextcloud sign-in ships in the free Community tier; Google and Microsoft SSO are part of Enterprise.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Users', span: 1,
                    title: 'Six roles, including the two your auditor asks about',
                    body: 'Organisation admin, agent admin, agent editor and member cover the day-to-day. Alongside them ship a Data Protection Officer role and an ISMS auditor role, because GDPR work and ISO 27001 work are real jobs with their own permissions rather than "give them admin and hope". Custom roles compose from around twenty-five granular permissions when the built-in six are not the right cut.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Share2', span: 2,
                    title: 'Sharing that follows your org chart',
                    body: 'Assistants, knowledge bases, skills and apps are private to their owner until shared — with the whole organisation or with specific groups. That is where the directory sync pays off: share a knowledge base with the Entra group for your finance team, and membership changes in the directory change access here, with nobody maintaining a second list. Apps built in App Studio go a level deeper, with row-level access rules enforced inside the app itself.',
                    techTag: '', media: media('', ''),
                },
            ],
        }),
        b('steps', {
            eyebrow: 'The journey',
            title: 'What happens when a new colleague signs in',
            variant: 'chapters',
            items: [
                {
                    number: '1',
                    title: 'The email domain decides the organisation',
                    body: 'A sign-in from your company domain lands in your organisation. A free-mail address — gmail.com, outlook.com and friends — deliberately never auto-binds to any organisation: that guard exists because we watched how easily a personal account could otherwise end up inside a tenant it had no business in. Country allowlists and invite links narrow the door further when you want them to.',
                    example: '',
                    media: media('', ''),
                },
                {
                    number: '2',
                    title: 'An admin approves, or your rules do',
                    body: 'People who sign in through SSO arrive as pending until an organisation admin approves them — or, with auto-approval switched on for a domain you trust, they land directly in the default groups you chose. A waitlist mode exists for when the door should stay closed entirely. Two things worth knowing: founders and platform admins are never locked out by their own approval flow, and colleagues provisioned by the directory sync itself are activated straight away unless you turn that off.',
                    example: 'pending → approved · auto-approve + default groups · waitlist',
                    media: media('', ''),
                },
                {
                    number: '3',
                    title: 'Groups arrive, and grants follow',
                    body: 'Access is decided in four layers: what the licence allows, what the platform operator made available, what your organisation admin granted, and what a group grants on top. Every layer can only add — nothing a group does can silently take away, and nothing an admin forgets can silently widen. This is the "one permission model" the rest of this site keeps mentioning, and this is the page where it is spelled out.',
                    example: 'licence → availability → org grant → group grant',
                    media: media('', ''),
                },
            ],
        }),
        b('security', {
            eyebrow: 'In writing',
            title: 'The parts an IT reviewer will want on paper',
            lead: '',
            variant: 'ledger',
            cards: [
                {
                    icon: 'Lock',
                    title: 'Password handling, and its limits',
                    summary: 'OPAQUE (RFC 9807) available for password login; TOTP as the second factor.',
                    details: [
                        'Accounts can move to OPAQUE, where verification happens without the server ever receiving the password; the default path is bcrypt over TLS',
                        'TOTP two-factor with QR enrolment and ten single-use recovery codes, stored hashed',
                        'MFA secrets are encrypted at rest; an organisation admin can reset MFA for a locked-out colleague',
                        'Session identifiers rotate at every authentication, closing the session-fixation route',
                    ],
                    link: { label: '', href: '' },
                },
                {
                    icon: 'Layers',
                    title: 'Grant-only, in four layers',
                    summary: 'Licence ceiling, operator availability, organisation grant, group grant — each can only add.',
                    details: [
                        'A capability reaches a person only when all four layers agree it should exist for them',
                        'Groups grant, they never revoke — leaving a group removes what the group gave, nothing else',
                        'Per-user toggles let people switch off what they were granted but do not want',
                        'The route-to-gate mapping is a reviewed file in the repository, tested against drift — not tribal knowledge',
                    ],
                    link: { label: '', href: '' },
                },
                {
                    icon: 'ScrollText',
                    title: 'An access audit log built for Article 30',
                    summary: 'Who changed whose access, and when — kept as evidence, not as debug output.',
                    details: [
                        'Role and access changes land in a dedicated audit table, indexed per organisation and time',
                        'Consent acceptances are an append-only ledger — the application only ever inserts into it, never updates or deletes',
                        'Every integration call is logged with its destination, so "which tools reached what" has an answer',
                    ],
                    link: { label: '', href: '' },
                },
                {
                    icon: 'Building2',
                    title: 'Tenant boundaries that hold',
                    summary: 'The sign-in and sync paths are designed around cross-tenant mistakes.',
                    details: [
                        'Free-mail domains never auto-bind to an organisation — the guard exists because we once needed it',
                        'Microsoft sign-in supports single-tenant and multi-tenant setups, with the tenant pinned when you pin it',
                        'Group sync respects seat caps instead of provisioning past them',
                        'Shared resources are validated against the organisation — a group from another tenant cannot be granted access',
                    ],
                    link: { label: '', href: '' },
                },
            ],
        }),
        b('trust-band', {
            variant: 'detailed',
            eyebrow: 'The boundary',
            title: 'Where the line is, said plainly',
            chips: [
                { icon: 'KeyRound', label: 'No SAML, no SCIM', sublabel: 'SSO is OAuth/OIDC with exactly three providers — Google, Microsoft Entra ID and Nextcloud. There is no SAML endpoint and no SCIM provisioning API. We would rather you read that here than discover it in week three of an evaluation.', href: '' },
                { icon: 'Plug', label: 'No generic IdP connector', sublabel: 'Okta, Keycloak or a custom OIDC issuer cannot be configured today. Directory sync covers Microsoft Entra ID and Nextcloud — Google Workspace sign-in works, Google group sync is not built.', href: '' },
                { icon: 'FileWarning', label: 'Password policy is minimum length', sublabel: 'Eight characters, no complexity rules, no breach checking. That is why MFA enrolment is one QR code away, and why SSO against your own IdP — which brings your policy with it — is the recommended path.', href: '' },
            ],
        }),
        b('techStats', {
            eyebrow: '',
            title: 'Identity, in numbers',
            stats: [
                { number: '3', label: 'identity providers with OAuth SSO' },
                { number: '6', label: 'built-in organisation roles, plus custom ones' },
                { number: '6h', label: 'default Entra group-sync interval once you enable it' },
                { number: '10', label: 'single-use recovery codes per enrolled second factor' },
            ],
        }, { band: 'dark' }),
        b('faq', {
            eyebrow: 'FAQ',
            title: 'The questions procurement actually asks',
            items: [
                {
                    question: 'Does Bee Flow support SSO?',
                    answer: 'Yes — OAuth sign-in with Google, Microsoft Entra ID and Nextcloud, with single-tenant and multi-tenant Microsoft setups both supported. Nextcloud sign-in is part of the free Community tier; Google and Microsoft SSO are Enterprise features. SAML is not implemented, and we say that out loud rather than in a footnote.',
                },
                {
                    question: 'Can I sync groups from Microsoft Entra ID?',
                    answer: 'Yes. An optional periodic sync — six hours by default once you enable it, and configurable — mirrors the groups assigned to the Bee Flow enterprise app. On top of that, a Microsoft login re-checks that person against the groups already mirrored here, which is where memberships they have lost are dropped. Deleting groups that vanished from Entra is a further opt-in called destructive sync, off by default. One caveat worth knowing: a brand-new group assigned in Entra arrives with the periodic or a manual sync, not through someone logging in.',
                },
                {
                    question: 'Does Bee Flow support SAML or SCIM?',
                    answer: 'No, and this page exists partly so nobody discovers that late. What ships is OAuth/OIDC SSO against three providers, plus group sync from Entra ID and Nextcloud — which covers most of what teams reach for SCIM for: keeping membership current without a second admin console. If SAML is a hard requirement, we are the wrong choice today.',
                },
                {
                    question: 'Can I restrict who signs up?',
                    answer: 'Yes: bind sign-ins to your email domain, hold new members pending until approved, auto-approve with default groups on a domain you trust, run a waitlist, restrict signups by country, or invite explicitly. Free-mail addresses never auto-join an organisation, whatever the other settings say.',
                },
                {
                    question: 'How does role-based access control work?',
                    answer: 'Six built-in organisation roles — including a Data Protection Officer role and an ISMS auditor role — plus custom roles built from around twenty-five granular permissions. Resources are shared per organisation or per group, four grant-only layers decide which capabilities exist for whom, and every access change lands in an audit log designed for GDPR Article 30 evidence.',
                },
                {
                    question: 'Does Bee Flow support two-factor authentication?',
                    answer: 'Yes — TOTP with any authenticator app, enrolled from a QR code, with ten hashed recovery codes and an admin reset path for lost devices. It is enforced on the standard password login; accounts migrated to the OPAQUE key-exchange path do not have the second factor enforced yet, and we would rather write that here than let you discover it.',
                },
            ],
        }),
        b('cta', {
            title: 'Point it at your own tenant',
            lead: 'The fastest way to evaluate the identity story is to run it: connect your Entra tenant or Nextcloud on a test install, watch the groups arrive, and read the audit log afterwards.',
            button: { label: 'Self-host it', link: pageLink('self-hosting') },
            secondaryCta: { label: 'Talk to us', link: pageLink('contact') },
            showMotif: true,
            backgroundVariant: 'dark',
        }),
    ],
};

// ── Langdock ───────────────────────────────────────
const langdockAlternative = {
    slug: 'langdock-alternative',
    title: 'Bee Flow vs Langdock',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'A self-hostable Langdock alternative | Bee Flow',
        metaDescription: 'Langdock is polished, certified and hosted. Bee Flow is self-hostable and auditable line by line. An honest comparison for European teams choosing.',
        ogImage: og('compare'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Comparison',
            badge: { enabled: true, text: 'Both European — different answers', icon: 'Scale' },
            titleParts: [{ text: 'The fairest fight on this site', gradient: false }],
            lead: 'Langdock and Bee Flow answer the same question — how does a European team use AI without mailing its data across the Atlantic — from opposite ends. Langdock is a polished hosted platform out of Berlin that advertises ISO 27001 and SOC 2 certification; Bee Flow is a Dutch workspace you can run on your own hardware and read line by line. Which answer you need depends on what your organisation has to be able to prove, and this page tries to make that decision faster rather than tilt it.',
            primaryCta: { enabled: true, label: 'Run it yourself', style: 'primary', link: pageLink('self-hosting') },
            secondaryCta: { enabled: true, label: 'All comparisons', style: 'secondary', link: pageLink('compare') },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'classic',
            media: media('', ''),
        }),
        b('content', {
            columnLayout: '2',
            columns: [
                {
                    id: 'col_ld_ahead',
                    elements: [{
                        id: 'el_ld_ahead', kind: 'text', align: 'left',
                        heading: 'Where Langdock is ahead, plainly',
                        subheading: '',
                        body: 'Certification, polish and adoption. Langdock advertises ISO 27001 and SOC 2 — audits of the company, which Bee Flow has not commissioned — and a hosted product with one deployment shape is easier to keep polished than a stack every customer runs differently. If your procurement checklist starts with a certificate and ends with a signed DPA, they clear it faster today. Their public customer list is longer than ours, and pretending otherwise would cost this page its credibility in the first paragraph.',
                    }],
                },
                {
                    id: 'col_ld_certificate',
                    elements: [{
                        id: 'el_ld_certificate', kind: 'text', align: 'left',
                        heading: 'The question a certificate does not answer',
                        subheading: '',
                        body: 'A certificate says an auditor reviewed the vendor’s processes. It does not say where a specific prompt went — only the operator of the infrastructure can answer that, and with a hosted product the operator is not you. Self-hosting moves you into that seat: the code is source-available, the PII detector runs on your own CPU, and the Compliance Center runs GDPR, EU AI Act and ISO 27001 checks against your live install. Instead of inheriting a vendor’s certificate, you build evidence about your own deployment — which, for some organisations, is the thing the auditor actually wants.',
                    }],
                },
            ],
        }),
        b('features', {
            eyebrow: 'What we bring',
            title: 'The case for the self-hostable answer',
            lead: '',
            variant: 'bento',
            items: [
                {
                    icon: 'Server', span: 2,
                    title: 'Self-hosting is the default, not the exception',
                    body: 'One command stands up the whole workspace from public images — no licence key, no account, no phone-home. Compose profiles let you start small, Kubernetes manifests are documented, and licences stay valid offline, which is what makes an air-gapped install with local models possible. There is no user, agent, message or knowledge-base cap in any tier, including the free Community tier, and all built-in integrations ship in it.',
                    techTag: 'Docker · Kubernetes · air-gap', media: media('', ''),
                },
                {
                    icon: 'Shield', span: 1,
                    title: 'A PII layer on your own hardware',
                    body: 'Once the detector is installed, personal data is found across 21 categories — with a Dutch fine-tune that validates a BSN by its checksum — and tokenised before any prompt reaches a model provider, then restored in the reply. Detection runs on your own CPU; no text goes to a third-party detection API, and an unreachable detector fails closed.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'KeyRound', span: 1,
                    title: 'Identity from your own directory',
                    body: 'OAuth SSO with Google, Microsoft Entra ID and Nextcloud, group sync from Entra ID, six built-in roles and an access audit log built for Article 30 evidence. The identity page spells out the whole chain, boundaries included.',
                    techTag: '', media: media('', ''), cardAction: 'link', cardUrl: '/identity-access',
                },
                {
                    icon: 'Boxes', span: 2,
                    title: 'A workspace, not a chat product',
                    body: 'Assistants share the building with automations — 27 step types, six trigger kinds, approval gates and dry runs — plus knowledge bases that cite the passage they used, meeting notes with speaker identification, and internal apps from App Studio. One permission model and one audit trail run under all of it, so the answer to "who did what, with which data" is one query rather than a reconciliation project.',
                    techTag: '', media: media('', ''),
                },
            ],
        }),
        b('compare-table', {
            eyebrow: 'Side by side',
            title: 'The comparison, in one table',
            lead: '',
            leftLabel: 'Bee Flow',
            rightLabel: 'Langdock',
            rows: [
                { aspect: 'Deployment', left: 'Self-hosted — Docker Compose or Kubernetes — or hosted by us on EU infrastructure', right: 'Hosted platform; their documentation lists the current deployment options' },
                { aspect: 'Company certification', left: 'None yet, and we say so — the product ships compliance tooling instead', right: 'Advertises ISO 27001 and SOC 2 certification' },
                { aspect: 'Source access', left: 'Source-available under the Sustainable Use License — auditable line by line', right: 'Proprietary' },
                { aspect: 'PII protection', left: 'Detector on your own CPU, 21 categories, tokenise-and-restore, fails closed', right: 'Platform DLP features, per their documentation' },
                { aspect: 'Model choice', left: 'Six provider adapters plus any OpenAI-compatible endpoint, local models included', right: 'Multiple hosted model providers' },
                { aspect: 'Beyond chat', left: 'Automations, meeting notes, internal apps, knowledge bases — one permission model', right: 'Chat, assistants, workflows and integrations' },
            ],
            footnote: 'Their column is drawn from public documentation. Treat their docs as authoritative — packaging changes faster than comparison pages do.',
        }),
        b('techStats', {
            eyebrow: '',
            title: 'What the free tier already holds',
            stats: [
                { number: '44', label: 'integrations built in, plus any MCP server' },
                { number: '21', label: 'PII categories detected on your own hardware' },
                { number: '27', label: 'automation step types, with approval gates' },
                { number: '0', label: 'user, agent or message caps in any tier' },
            ],
        }, { band: 'dark' }),
        b('faq', {
            eyebrow: 'Questions',
            title: 'What teams comparing the two ask',
            items: [
                {
                    question: 'Is Bee Flow ISO 27001 certified?',
                    answer: 'No. Langdock advertises certification and we do not, and pretending a product module equals a company audit would be exactly the kind of claim this site refuses to make. What ships instead is a Compliance Center that runs 15 GDPR, 6 EU AI Act and 23 ISO 27001 checks against your live configuration, plus an ISMS layer — Statement of Applicability, risk register, internal audits, evidence bundles. That is tooling for certifying your own installation, which is a thing no vendor certificate covers.',
                },
                {
                    question: 'Can we self-host Langdock?',
                    answer: 'Their documentation is the authority on current deployment options — check it there rather than trusting a competitor’s page to stay up to date. What we can say about our own side: self-hosting at any scale is a supported, documented, one-command path on the free tier. If running it yourself is a hard requirement, that difference settles the evaluation quickly.',
                },
                {
                    question: 'Is Bee Flow as polished?',
                    answer: 'A hosted product with one shape is easier to polish than a self-hostable stack, and Langdock has clearly invested in theirs. Where we spend that effort instead is inspectability: source you can read, audit trails you own, a sovereignty report with real destination countries. Try both — polish is precisely the property you can judge in an afternoon.',
                },
                {
                    question: 'Does Bee Flow have as many integrations?',
                    answer: mcpAnswer('The two products count differently, so compare capabilities rather than catalogue lengths.'),
                },
                { question: 'Is this open source?', answer: LICENCE_ANSWER },
            ],
        }),
        b('cta', {
            title: 'Two European answers — test the one you can hold',
            lead: 'Stand Bee Flow up on your own hardware next to a Langdock trial and run the same week of work through both. Which one fits will be obvious faster than any feature grid can make it.',
            button: { label: 'Self-host it', link: pageLink('self-hosting') },
            secondaryCta: { label: 'All comparisons', link: pageLink('compare') },
            showMotif: true,
            backgroundVariant: 'dark',
        }),
    ],
};

// ── Dust ───────────────────────────────────────────
const dustAlternative = {
    slug: 'dust-alternative',
    title: 'Bee Flow vs Dust',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'A self-hosted Dust (dust.tt) alternative | Bee Flow',
        metaDescription: 'Dust builds excellent hosted agents over Slack and Notion. Bee Flow runs agents, automations and RAG on infrastructure you hold. The honest trade-offs.',
        ogImage: og('compare'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Comparison',
            badge: { enabled: true, text: 'Hosted agents vs a sovereign workspace', icon: 'Scale' },
            titleParts: [{ text: 'Excellent hosted agents. A different question.', gradient: false }],
            lead: 'Dust, out of Paris, builds hosted agents over the tools a modern company lives in — Slack, Notion, Google Drive — and does it well. If "hosted" is a word your security team can sign, it belongs on your shortlist and this page will not talk you out of it. This page is for the organisations where "hosted" is itself the question: where the agents, the automations and the retrieval have to run on infrastructure you hold, against a model you chose — possibly one on your own network — with an audit trail you own.',
            primaryCta: { enabled: true, label: 'Build the same agent here', style: 'primary', link: pageLink('assistants') },
            secondaryCta: { enabled: true, label: 'All comparisons', style: 'secondary', link: pageLink('compare') },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'classic',
            media: media('', ''),
        }),
        b('features', {
            eyebrow: 'Where the two differ',
            title: 'An agent platform, or a workspace the agents live in',
            lead: '',
            variant: 'bento',
            items: [
                {
                    icon: 'Boxes', span: 2,
                    title: 'Where Dust is ahead, plainly',
                    body: 'Their Slack and Notion connectors are deeper than what we ship — Slack reaches Bee Flow through an MCP server rather than a native integration, and if your company thinks in Slack threads and Notion pages, Dust meets it exactly there. The product also moves quickly, with serious backing behind it. If those tools are your centre of gravity and hosting elsewhere is acceptable to your reviewers, Dust is a strong choice and you should evaluate it properly.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'KeyRound', span: 1,
                    title: 'One permission model under everything',
                    body: 'Agents, automations, knowledge bases and apps share a single grant-only rights model, with groups synced from Microsoft Entra ID or Nextcloud deciding membership. A workflow that calls an agent leaves one audit trail, not two systems to reconcile afterwards.',
                    techTag: '', media: media('', ''), cardAction: 'link', cardUrl: '/identity-access',
                },
                {
                    icon: 'Brain', span: 1,
                    title: 'The model is a setting, not the product',
                    body: 'Six provider adapters — OpenAI, Anthropic, Google, Google Vertex, Azure OpenAI, Mistral — plus any OpenAI-compatible endpoint, which is how a model on your own GPU joins the list. Chosen per assistant or per conversation, with cost tracked per model.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Workflow', span: 2,
                    title: 'Automations beside the agents, not bolted on',
                    body: 'The workflow engine is in the same building: 27 step types with conditions, loops, parallel branches, approval gates and dry runs, triggered by schedules, webhooks, forms, app events or an agent deciding to call one. An automation can tokenise personal data on the way out and restore it on the way back, using the same privacy layer the chat runs behind.',
                    techTag: '', media: media('', ''),
                },
            ],
        }),
        b('content', {
            columnLayout: '2',
            columns: [
                {
                    id: 'col_dust_prove',
                    elements: [{
                        id: 'el_dust_prove', kind: 'text', align: 'left',
                        heading: 'What you can prove afterwards',
                        subheading: '',
                        body: 'Sovereignty here is measured, not promised: the usage report resolves each integration and model endpoint to a destination, guardrail events record every privacy decision without copying the sensitive text, and the audit trail is a table in your own database rather than an export you request from a vendor. When somebody accountable asks where the data went, the answer is a report you generate, not a ticket you open.',
                    }],
                },
                {
                    id: 'col_dust_pii',
                    elements: [{
                        id: 'el_dust_pii', kind: 'text', align: 'left',
                        heading: 'Personal data, handled before the provider',
                        subheading: '',
                        body: 'Once the detector is installed, names, mail addresses and account numbers are tokenised on your own CPU before a prompt leaves for any model provider, and restored in the reply — 21 categories, with Dutch identifiers validated rather than guessed. That is a different posture from trusting a provider’s retention agreement: the provider never receives the customer name in the first place.',
                    }],
                },
            ],
        }),
        b('compare-table', {
            eyebrow: 'Side by side',
            title: 'The short version',
            lead: '',
            leftLabel: 'Bee Flow',
            rightLabel: 'Dust',
            rows: [
                { aspect: 'Deployment', left: 'Self-hosted — Docker Compose or Kubernetes — or hosted by us on EU infrastructure', right: 'Hosted SaaS; code is public on GitHub — their docs describe the supported path' },
                { aspect: 'Focus', left: 'A workspace: chat, agents, automations, meetings, knowledge, internal apps', right: 'Agents and assistants over SaaS connectors' },
                { aspect: 'Slack and Notion', left: 'Via MCP servers — honestly, thinner than theirs', right: 'Native, deep connectors' },
                { aspect: 'Model choice', left: 'Six providers plus any OpenAI-compatible endpoint, local models included', right: 'Major hosted providers' },
                { aspect: 'PII handling', left: 'On-CPU detector, 21 categories, tokenise before the provider sees it', right: 'Provider retention agreements, per their documentation' },
                { aspect: 'Audit', left: 'Audit trail, guardrail log and sovereignty report in your own database', right: 'Platform logs, per their documentation' },
            ],
            footnote: 'Their column is drawn from public documentation. Treat their docs as authoritative — this page will age, theirs will not.',
        }),
        b('techStats', {
            eyebrow: '',
            title: 'The workspace around the agents',
            stats: [
                { number: '6', label: 'model providers, plus any OpenAI-compatible endpoint' },
                { number: '89', label: 'servers in the MCP catalogue, plus any you write' },
                { number: '27', label: 'automation step types under the same permissions as agents' },
                { number: '1', label: 'audit trail across chat, agents and automations' },
            ],
        }, { band: 'dark' }),
        b('faq', {
            eyebrow: 'Questions',
            title: 'What teams comparing the two ask',
            items: [
                {
                    question: 'Can Bee Flow connect to Slack and Notion?',
                    answer: 'Through MCP servers, yes — install the Slack or Notion MCP server and their tools become available to assistants and automations with the same permissions and audit trail as built-in integrations. Native first-party connectors for those two we do not have, and Dust’s are genuinely deeper. If Slack is your company’s operating system, weigh that heavily.',
                },
                {
                    question: 'Can we self-host Dust?',
                    answer: 'Their code is public on GitHub and their documentation is the authority on what is supported — check there rather than taking a competitor’s word for it. On our side, running Bee Flow yourself is a supported, documented, one-command path on the free tier. That difference is most of this page.',
                },
                {
                    question: 'Do agents and automations share permissions?',
                    answer: 'Yes — one grant-only model across chat, agents, automations, knowledge bases and apps, with group sync from Microsoft Entra ID or Nextcloud keeping membership current. The identity page walks the whole chain, including what is deliberately not implemented.',
                },
                {
                    question: 'Which models can we use?',
                    answer: 'OpenAI, Anthropic, Google, Google Vertex, Azure OpenAI and Mistral through built-in adapters, plus any OpenAI-compatible endpoint — which is how Ollama, vLLM or llama.cpp on your own hardware join the list. The model is a per-assistant or per-conversation choice, and the usage report knows what each one spent.',
                },
                { question: 'Is this open source?', answer: LICENCE_ANSWER },
            ],
        }),
        b('cta', {
            title: 'Build the same agent twice',
            lead: 'Take one real piece of work — a weekly summary, a support draft, a research brief — and build it in both products. The differences this page describes become concrete within an afternoon.',
            button: { label: 'Try the assistant editor', link: pageLink('assistants') },
            secondaryCta: { label: 'Run the whole stack', link: pageLink('self-hosting') },
            showMotif: true,
            backgroundVariant: 'dark',
        }),
    ],
};

// ── Open WebUI / LibreChat ─────────────────────────
//
// One page for both, like the Microsoft page covers three products: the
// reader evaluating a self-hosted chat UI holds the same question either
// way — what does a workspace add that the chat UI does not have.
const openWebuiAlternative = {
    slug: 'open-webui-alternative',
    title: 'Bee Flow vs Open WebUI & LibreChat',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'An Open WebUI and LibreChat alternative for teams | Bee Flow',
        metaDescription: 'Open WebUI and LibreChat give you a self-hosted chat UI. Bee Flow adds automations, cited RAG, SSO with group sync, PII redaction and audit trails.',
        ogImage: og('compare'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Comparison',
            badge: { enabled: true, text: 'Same models, more workspace', icon: 'Scale' },
            titleParts: [{ text: 'You already self-host the chat. This is the rest.', gradient: false }],
            lead: 'Open WebUI and LibreChat are the standard answers for a self-hosted chat interface, and this page will not pretend otherwise — they are good, their communities are far larger than ours, and if a chat UI over your Ollama or vLLM server is the whole requirement, install one of them and be happy. Bee Flow speaks the same OpenAI-compatible endpoints those servers expose. The difference is everything an organisation ends up needing around the chat: sign-in from your identity provider, groups and roles, redaction of personal data, automations, knowledge bases that cite their sources, and the audit trail that says who did what.',
            primaryCta: { enabled: true, label: 'See the platform', style: 'primary', link: pageLink('platform') },
            secondaryCta: { enabled: true, label: 'All comparisons', style: 'secondary', link: pageLink('compare') },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'classic',
            media: media('', ''),
        }),
        b('content', {
            columnLayout: '2',
            columns: [
                {
                    id: 'col_owu_win',
                    elements: [{
                        id: 'el_owu_win', kind: 'text', align: 'left',
                        heading: 'Where they win, honestly',
                        subheading: '',
                        body: 'Both are genuinely open source under OSI-approved licences, where Bee Flow’s Sustainable Use License is source-available — if OSI purity is a requirement, they meet it and we do not, and the licensing answer below does not soften that. Their communities are larger, their ecosystems of extensions are broader, and a chat UI is a far lighter thing to operate than a workspace: if chat over local models is the entire job, they are the smaller, sharper tool.',
                    }],
                },
                {
                    id: 'col_owu_after',
                    elements: [{
                        id: 'el_owu_after', kind: 'text', align: 'left',
                        heading: 'What gets bolted on after the pilot works',
                        subheading: '',
                        body: 'Then the pilot succeeds, and the questions change: who approved this tool having access to the CRM, can the intern see the salary documents in the knowledge base, what left the network last Tuesday, and can we show the auditor. Those answers are identity, roles, redaction and audit — the parts that are hard to retrofit around a chat UI, and the parts Bee Flow starts with. The difference between a chat UI and a workspace is everything that happens after the pilot works.',
                    }],
                },
            ],
        }),
        b('features', {
            eyebrow: 'The workspace parts',
            title: 'What surrounds the chat here',
            lead: '',
            variant: 'bento',
            items: [
                {
                    icon: 'KeyRound', span: 2,
                    title: 'Identity from your directory, not another user table',
                    body: 'OAuth SSO with Google, Microsoft Entra ID and Nextcloud; groups synced from Entra ID and mirrored from Nextcloud in near real time; six built-in roles including a Data Protection Officer and an ISMS auditor; TOTP two-factor; and an access audit log designed for GDPR Article 30 evidence. Sharing follows the directory — a knowledge base shared with a synced group tracks the directory, with no second membership list to maintain.',
                    techTag: '', media: media('', ''), cardAction: 'link', cardUrl: '/identity-access',
                },
                {
                    icon: 'Shield', span: 1,
                    title: 'Redaction before the model',
                    body: 'Once the detector is installed, personal data across 21 categories is blocked or tokenised on your own CPU before a prompt reaches any provider, and restored in the reply. No GPU needed, no third-party detection API, and an unreachable detector fails closed rather than quietly open.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Workflow', span: 1,
                    title: 'Automations, not just conversations',
                    body: '27 step types, six trigger kinds — schedules, webhooks, forms, app events, manual, or an agent calling an automation as a tool — with approval gates, dry runs and per-step history. Built by describing what you want, or by hand on a canvas.',
                    techTag: '', media: media('', ''),
                },
                {
                    icon: 'Library', span: 2,
                    title: 'Knowledge with receipts, meetings that write themselves up',
                    body: 'Knowledge bases index your documents and answer with citations to the passage used, scoped per group. Meeting notes arrive as diarised transcripts with speakers named, summaries and action items — with the transcription engine self-hostable on your own GPU. Usage monitoring shows which models, which people and what it cost, with a local model reporting zero.',
                    techTag: '', media: media('', ''),
                },
            ],
        }),
        b('trust-band', {
            variant: 'detailed',
            eyebrow: 'Our boundaries',
            title: 'Said before you ask',
            chips: [
                { icon: 'Scale', label: 'Not OSI open source', sublabel: 'The Sustainable Use License is source-available: read it, modify it, run it internally free — reselling it as a hosted service is what is restricted. We are working toward AGPL-3.0-or-later; the Nextcloud connector already carries it.', href: '' },
                { icon: 'ServerCog', label: 'A heavier stack than a chat UI', sublabel: 'PostgreSQL, object storage, Redis recommended, optional services per feature. Compose profiles keep the start small, but a workspace is simply more machine than a chat interface — if you do not need the workspace, do not run one.', href: '' },
                { icon: 'KeyRound', label: 'No SAML, no SCIM', sublabel: 'SSO is OAuth with Google, Microsoft Entra ID and Nextcloud, with directory sync from the latter two. The identity page names everything that is deliberately not implemented.', href: '' },
            ],
        }),
        b('compare-table', {
            eyebrow: 'Side by side',
            title: 'Chat UI or workspace, in one table',
            lead: '',
            leftLabel: 'Bee Flow',
            rightLabel: 'Open WebUI / LibreChat',
            rows: [
                { aspect: 'Licence', left: 'Source-available (Sustainable Use License), moving toward AGPL', right: 'OSI open source' },
                { aspect: 'Local models', left: 'Any OpenAI-compatible endpoint — Ollama, vLLM, llama.cpp', right: 'The same — it is their home turf' },
                { aspect: 'SSO and directory groups', left: 'Google, Microsoft Entra ID with group sync, Nextcloud mirrored live', right: 'Varies by project and setup; their docs are authoritative' },
                { aspect: 'PII redaction', left: 'Built in: on-CPU detector, 21 categories, block or tokenise, fails closed', right: 'Commonly added via external layers such as Presidio' },
                { aspect: 'Automations', left: '27 step types, six trigger kinds, approval gates, run history', right: 'Chat-centric; automation lives in external tooling' },
                { aspect: 'Compliance evidence', left: 'GDPR, EU AI Act and ISO 27001 checks against your live install', right: 'Not a stated product goal' },
            ],
            footnote: 'Both projects move quickly — their documentation is authoritative for their column, and this table describes the built-in paths, not what a determined admin can assemble.',
        }),
        b('faq', {
            eyebrow: 'Questions',
            title: 'What self-hosters ask us',
            items: [
                {
                    question: 'Does Bee Flow work with Ollama or vLLM?',
                    answer: 'Yes — point it at any OpenAI-compatible endpoint, which is exactly how those servers present themselves. There is no special Ollama integration and none is needed: the endpoint URL is the integration, and the same goes for llama.cpp, LM Studio or anything else speaking that dialect.',
                },
                { question: 'Is Bee Flow open source like Open WebUI?', answer: LICENCE_ANSWER },
                {
                    question: 'Why is Bee Flow heavier to run?',
                    answer: 'Because it is a workspace, not a chat window: PostgreSQL with pgvector, S3-compatible object storage, Redis when you scale past one replica, and optional services for PII detection, search and transcription. Compose profiles mean you start with the core and add services as features earn their keep — but if a chat UI is the whole requirement, the honest advice is that a chat UI is less to operate.',
                },
                {
                    question: 'Can we keep Open WebUI next to it?',
                    answer: 'Yes, and teams do — both speak to the same model servers, so nothing conflicts. A sensible migration is running both: keep the chat UI you like while the workspace takes over the parts that need permissions, redaction, automations and audit. Nothing about Bee Flow requires a big-bang switch.',
                },
                {
                    question: 'Do you support multiple providers in one place like LibreChat?',
                    answer: 'Yes — six built-in provider adapters plus any OpenAI-compatible endpoint, selectable per assistant or per conversation, with cost tracked per model. The difference is not the multi-provider chat; it is the permission model, redaction and audit trail underneath it.',
                },
            ],
        }),
        b('cta', {
            title: 'Same models. More building around them.',
            lead: 'Connect the model server you already run and rebuild one real piece of work — the difference between a chat UI and a workspace shows up in the second week, so start with the part the chat UI does not do.',
            button: { label: 'Self-host it', link: pageLink('self-hosting') },
            secondaryCta: { label: 'Explore the platform', link: pageLink('platform') },
            showMotif: true,
            backgroundVariant: 'dark',
        }),
    ],
};

// ── /changelog ────────────────────────────────────────────────────────
// The release-notes block stores NO entries — it reads published releases from
// GET /api/release-notes/public at view time, so this page is empty until a
// human publishes one in Admin → Release notes. The surrounding copy exists to
// make the page worth visiting on its own.
//
// FACT-CHECK (same standard as the roadmap page — every claim traceable):
//   * two channels, and what each publishes: .github/workflows/build-push-ghcr.yml
//     — push to main tags :dev + :dev-sha-<sha>; a manual channel=prod
//     run (main only) tags :latest + :prod + :sha-<sha>.
//   * a production release cuts a GitHub Release with the commit/PR list:
//     the `release` job, softprops/action-gh-release with generate_release_notes.
//   * images live at ghcr.io/bee-flow/<service>: IMAGE_PREFIX in the same file.
//   * self-hosters pull the images themselves: selfhost.sh +
//     docker-compose.from-registry.yml. We do not reach into anyone's install.
// No dates and no forward-looking promises in the static copy — everything
// dated on this page comes from a real, published release.
const changelogPage = {
    slug: 'changelog',
    title: 'Changelog',
    isHomepage: false, hideHeader: false, hideFooter: false, isNotFound: false, noAnalytics: false,
    seo: {
        metaTitle: 'Changelog — what shipped in Bee Flow',
        metaDescription: 'Every Bee Flow release, what changed in it, and what that means if you run the product — in plain language, not commit messages.',
        ogImage: og('workspace'),
        noIndex: false,
    },
    blocks: [
        b('hero', {
            eyebrow: 'Changelog',
            badge: { enabled: false, text: '', icon: '' },
            titleParts: [{ text: 'What shipped, and what it changes for you', gradient: false }],
            lead: 'Release notes written in plain language: what is new, what got better, and what was broken and now is not. Each entry names the release it belongs to, so you can tell at a glance whether the version you are running already has it.',
            primaryCta: { enabled: true, label: 'Read the roadmap', style: 'primary', link: pageLink('roadmap') },
            secondaryCta: { enabled: true, label: 'Self-hosting guide', style: 'secondary', link: pageLink('self-hosting') },
            mockup: { enabled: false, chatBubbles: [] },
            variant: 'classic',
            media: media('', ''),
        }),
        b('release-notes', {
            variant: 'full',
            eyebrow: '',
            title: 'Releases',
            lead: '',
            limit: 20,
            emptyText: 'The first release notes will appear here.',
        }),
        b('content', {
            columnLayout: '2',
            columns: [
                {
                    id: 'col_ship_channels',
                    elements: [{
                        id: 'el_ship_channels',
                        kind: 'text',
                        heading: 'How a change reaches you',
                        subheading: '',
                        body: 'Bee Flow ships as container images. Every merge to the main branch builds a development image, which is how a change gets exercised before anyone calls it a release. A production release is a separate, deliberate step: someone runs it by hand, and only from the main branch. That is the moment the images are tagged as the current production version and a release is cut with the full list of commits behind it.\n\nThe practical consequence is that a note on this page describes something that has already been built, tagged and published — not something planned. Plans live on the roadmap, and the roadmap is careful to say that it describes what is being worked on rather than what is promised.\n\nNotes are grouped the way you are likely to read them: what is new, what existing behaviour improved, and what was broken and now works. Entries that only matter to the people maintaining the code — dependency updates, build changes, internal cleanup — are left out on purpose. A changelog nobody finishes reading is worse than a short one.',
                        align: 'left',
                    }],
                },
                {
                    id: 'col_ship_control',
                    elements: [{
                        id: 'el_ship_control',
                        kind: 'text',
                        heading: 'You decide when to take it',
                        subheading: '',
                        body: 'If you self-host, nothing here reaches your install on its own. The images are published to a public registry and you pull the version you want, when you want it. An upgrade is you deciding to run one — which also means a release note is information you act on rather than a change that has already happened to you.\n\nOn the managed European cloud we apply releases for you, and the version running there is the one named in the most recent entry below. Either way the same images are involved: there is no separate build for paying customers, and no private variant of the product.\n\nIf you are deciding whether an upgrade is worth scheduling, the entries below are written to answer exactly that. Where a change affects how you configure or operate an install rather than how the product looks, the note says so, so an administrator can tell the difference between a release worth reading about and one worth planning around.',
                        align: 'left',
                    }],
                },
            ],
        }),
        b('github-stats', {
            eyebrow: 'In the open',
            title: 'Every release is public',
            lead: 'Each production release is tagged in the repository with the full commit and pull-request list behind it. If a note here is too brief for what you need, the underlying history is one click away.',
            repoUrl: 'https://github.com/Bee-Flow/Bee-Flow',
            linkLabel: 'Browse the repository',
        }),
        b('cta', {
            title: 'Run the version you just read about',
            lead: 'Self-host it on your own infrastructure, or let us run it in the European cloud.',
            button: { label: 'See the editions', link: pageLink('editions') },
            secondaryCta: { label: 'Talk to us', link: pageLink('contact') },
        }),
    ],
};

const PAGES = [
    home, platform, agentsPage, automations, notebooksPage, meetingNotes,
    privacyShieldPage, security, identityAccess, integrations, selfHosting,
    pricing, editionsPage, cloud, roadmapPage, sovereignty,
    skillsPage, knowledgePage, monitoringPage, supportPage, compliancePage,
    appStudioPage,
    comparePage, microsoftAlternative,
    n8nAlternative, zapierAlternative, makeAlternative,
    chatgptAlternative, geminiAlternative, claudeAlternative,
    langdockAlternative, dustAlternative, openWebuiAlternative,
    about, contact,
    changelogPage,
];

/**
 * The export bundle. `exportedAt` is filled in by the seeder so this module
 * stays a pure value (and so re-requiring it never produces a diff).
 */
function buildBundle({ exportedAt = new Date().toISOString(), name = 'Bee Flow' } = {}) {
    return {
        _beeflow_export: true,
        version: 2,
        exportedAt,
        site: {
            name,
            defaultLocale: 'en',
            locales: ['en'],
            settings: { homepageSlug: 'home' },
            design,
            analytics: { gaMeasurementId: '' },
            chrome: { header, footer, cookieBanner, announcement },
            pages: PAGES,
        },
    };
}

module.exports = { buildBundle, PAGES };
