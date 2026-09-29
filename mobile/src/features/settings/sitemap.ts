/**
 * The app's sitemap — every place a person can go, in one list.
 *
 * This exists as data rather than as JSX because the More tab has to do three
 * things with the same set: render it grouped, filter it by a search string,
 * and hide the entries a given account cannot reach. Hard-coding that three
 * times in a screen is how a destination goes missing.
 *
 * The acceptance criterion for the More tab is that EVERY Bee Flow feature is
 * reachable from here, so a new screen anywhere in the app is expected to add
 * a row to this file. Screens owned by other feature modules are linked, never
 * described — the route is the contract.
 *
 * `requires` is deliberately coarse. It names the permission or capability the
 * DESTINATION needs, and the More tab uses it only to hide rows that would
 * certainly 403; anything ambiguous stays visible, because a screen that says
 * "not available on your plan" is far better than a screen that does not
 * exist and leaves the user hunting.
 */

import type { Feather } from '@expo/vector-icons';

export type FeatherIcon = keyof typeof Feather.glyphMap;

export type SitemapGroup = 'Workspace' | 'Content' | 'Organisation' | 'Account' | 'Help';

export interface Destination {
    /** Stable key — used for the list key, not shown. */
    id: string;
    label: string;
    /** One line, sentence case. It is also matched by the search field. */
    hint: string;
    icon: FeatherIcon;
    /** An in-app route, or an absolute URL opened in the browser. */
    href: string;
    group: SitemapGroup;
    /** Extra words that should match in search but are not worth showing. */
    keywords?: string[];
    /**
     * This destination's label in the server's GUI string catalogue.
     *
     * Deliberately the WEB's own key (`sidebar.agents`, `settings.appearance`)
     * rather than a mobile-specific one: a string an administrator has already
     * translated for the browser then appears on the phone with nobody
     * translating it twice, and the two clients cannot drift into calling the
     * same screen different things in Dutch.
     *
     * Absent where the catalogue has no key for it — inventing one would put a
     * key in the haystack that resolves to its own English fallback, which
     * matches nothing a Dutch user would type and costs a comparison.
     */
    i18nKey?: string;
    /**
     * Permission id from server/auth/permissions.js SYSTEM_PERMISSIONS, or the
     * pseudo-permission 'org_admin'. Omit when everyone may at least look.
     */
    requires?: string;
    /** True for destinations that leave the app. */
    external?: boolean;
    /**
     * How prominently More renders it. Beside `requires` rather than instead of
     * it: permission decides whether you may see a row at all, weight decides
     * where it sits once you may.
     *
     *   `primary` — one of the six in the grid at the top. Earned by being a
     *               destination people come to More FOR.
     *   `normal`  — a grouped row. The default.
     *   `hidden`  — not rendered, but STILL SEARCHABLE. For the four rows that
     *               mirror a tab you are already looking at, and the twelve
     *               settings children that also live inside /settings — a
     *               directory that lists /settings/appearance twice, once at
     *               the top level and once under Settings, is not a directory.
     *
     * `hidden` deliberately does not mean "gone": typing "transcribe" must
     * still find Record, and sitemap.test.ts's completeness guarantee still
     * counts these rows.
     */
    weight?: 'primary' | 'normal' | 'hidden';
}

export const GROUP_ORDER: SitemapGroup[] = [
    'Workspace',
    'Content',
    'Organisation',
    'Account',
    'Help',
];

export const DESTINATIONS: Destination[] = [
    // ── Workspace: the four tabs plus the two things you reach for from
    //    anywhere. Listed here even though they are one tap away in the tab
    //    bar, because this screen is meant to be the whole map — a person who
    //    comes here looking for "recordings" should find it, not be told to
    //    look at the tab bar they already looked at.
    {
        id: 'chat',
        weight: 'hidden',
        label: 'Chat',
        hint: 'Start something new, and your recent conversations',
        icon: 'message-square',
        href: '/(tabs)',
        group: 'Workspace',
        keywords: ['conversation', 'agent', 'ai', 'assistant', 'nieuw', 'gesprek'],
    },
    {
        id: 'chats',
        i18nKey: 'sidebar.chats',
        label: 'All conversations',
        hint: 'Every chat, grouped by when you last touched it',
        icon: 'message-circle',
        href: '/chats',
        group: 'Workspace',
        // The full list stopped being the Chat tab's root when the composer
        // took that slot, so it needs a row of its own — a screen reachable
        // only by knowing a footer link exists is a screen nobody finds.
        keywords: ['history', 'archive', 'past', 'gesprekken', 'geschiedenis'],
    },
    {
        id: 'record',
        weight: 'hidden',
        label: 'Record',
        hint: 'Capture and transcribe a meeting',
        icon: 'mic',
        href: '/(tabs)/record',
        group: 'Workspace',
        keywords: ['meeting', 'transcribe', 'transcription', 'audio', 'voice', 'notes'],
    },
    {
        id: 'library',
        weight: 'hidden',
        label: 'Library',
        hint: 'Everything you read and reference',
        icon: 'book-open',
        href: '/(tabs)/library',
        group: 'Workspace',
        keywords: ['notebooks', 'knowledge', 'documents'],
    },
    {
        id: 'cowork',
        weight: 'hidden',
        i18nKey: 'sidebar.cowork',
        label: 'Cowork',
        hint: 'Work you handed over, that runs without you',
        icon: 'users',
        href: '/(tabs)/cowork',
        group: 'Workspace',
        // 'automate' stays in the keywords, not the label. The tab is named
        // for the web's word now, but anybody who learned this app before the
        // rename still types the old one — and the whole point of the search
        // corpus is that it answers the word in the person's head.
        keywords: [
            'automate', 'automation', 'schedule', 'workflow', 'delegate',
            'recurring', 'samenwerken', 'gepland', 'taken',
        ],
    },
    {
        id: 'agents',
        i18nKey: 'sidebar.agents',
        weight: 'primary',
        label: 'Agents',
        hint: 'Every agent you can open, and the chats you had with them',
        icon: 'users',
        href: '/agents',
        group: 'Workspace',
        keywords: ['agent hub', 'assistant', 'bot', 'favourites', 'favorites', 'published'],
    },
    {
        id: 'voice',
        weight: 'primary',
        label: 'Voice mode',
        hint: 'Talk to Bee Flow and hear it answer',
        icon: 'mic',
        href: '/voice',
        group: 'Workspace',
        // Not gated by `requires`: voice needs a server capability AND a
        // configured Mistral key, and the screen itself explains which of the
        // two is missing and who can fix it. Hiding the row would leave a
        // self-hoster with no way to find out the feature exists.
        keywords: ['speak', 'talk', 'speech', 'spoken', 'hands free', 'call'],
    },
    {
        id: 'search',
        i18nKey: 'sidebar.search',
        weight: 'hidden',
        label: 'Search everything',
        hint: 'One search across chats, documents and knowledge',
        icon: 'search',
        href: '/search',
        group: 'Workspace',
        keywords: ['find', 'lookup'],
    },
    {
        id: 'notifications',
        weight: 'hidden',
        label: 'Notifications',
        hint: 'What finished, what needs you',
        icon: 'bell',
        href: '/notifications',
        group: 'Workspace',
        keywords: ['alerts', 'inbox'],
    },

    // ── Content
    {
        id: 'notebooks',
        i18nKey: 'sidebar.notebooks',
        label: 'Notebooks',
        hint: 'Long-form notes your agents can read',
        icon: 'book',
        href: '/notebooks',
        group: 'Content',
        keywords: ['notes', 'writing'],
    },
    {
        id: 'knowledge',
        label: 'Knowledge bases',
        hint: 'Sources your agents search before answering',
        icon: 'database',
        href: '/knowledge',
        group: 'Content',
        keywords: ['kb', 'rag', 'sources', 'retrieval'],
    },
    {
        id: 'documents',
        label: 'Documents',
        hint: 'Files you have uploaded',
        icon: 'file-text',
        href: '/documents',
        group: 'Content',
        keywords: ['files', 'uploads', 'pdf'],
    },
    {
        id: 'skills',
        weight: 'primary',
        label: 'Skills',
        hint: 'Reusable instruction packs you can switch on in a chat',
        icon: 'award',
        href: '/skills',
        group: 'Content',
        keywords: ['instructions', 'prompt pack', 'playbook'],
    },
    {
        id: 'memory',
        i18nKey: 'settings.memory',
        weight: 'primary',
        label: 'Memory',
        hint: 'What Bee Flow remembers about you between conversations',
        icon: 'bookmark',
        href: '/memory',
        group: 'Content',
        keywords: ['remember', 'forget', 'recall', 'personalisation'],
    },
    {
        id: 'templates',
        i18nKey: 'sidebar.templates',
        label: 'Templates',
        hint: 'Reusable prompts and starting points',
        icon: 'copy',
        href: '/templates',
        group: 'Content',
        keywords: ['prompt', 'starter'],
    },
    {
        id: 'projects',
        i18nKey: 'sidebar.projects',
        label: 'Projects',
        hint: 'Group chats, files and automations by the work they belong to',
        icon: 'folder',
        href: '/projects',
        group: 'Content',
        keywords: ['workspace', 'folder'],
    },
    {
        id: 'apps',
        label: 'Apps',
        hint: 'Small tools built in App Studio',
        icon: 'grid',
        href: '/apps',
        group: 'Content',
        keywords: ['studio', 'tools'],
    },
    {
        id: 'approvals',
        label: 'Approvals',
        hint: 'Decisions an automation is waiting on',
        icon: 'check-square',
        href: '/approvals',
        group: 'Content',
        // Had no row at all until its list screen existed: the only entrance
        // was an unread notification, so a decided approval was unreachable.
        keywords: ['approve', 'reject', 'waiting', 'decision', 'goedkeuren', 'wacht', 'besluit'],
    },
    {
        id: 'automations',
        label: 'Automations',
        hint: 'Scheduled and triggered runs, with their history',
        icon: 'repeat',
        href: '/automations',
        group: 'Content',
        keywords: ['schedule', 'trigger', 'runs', 'workflow'],
    },
    {
        id: 'tasks',
        i18nKey: 'sidebar.tasks',
        label: 'Tasks and reminders',
        hint: 'What you asked Bee Flow to come back to you about',
        icon: 'check-square',
        href: '/tasks',
        group: 'Content',
        keywords: ['todo', 'reminder', 'agenda'],
    },

    // ── Organisation
    {
        id: 'org',
        label: 'Organisation',
        hint: 'Your company profile and its settings',
        icon: 'briefcase',
        href: '/org',
        group: 'Organisation',
        keywords: ['company', 'tenant', 'workspace'],
    },
    {
        id: 'org-members',
        label: 'Members and roles',
        hint: 'Who is in your organisation and what they may do',
        icon: 'users',
        href: '/org/members',
        group: 'Organisation',
        keywords: ['people', 'users', 'permissions', 'groups', 'invite'],
    },
    {
        id: 'org-privacy',
        i18nKey: 'settings.compliance',
        label: 'Privacy and compliance',
        hint: 'Privacy Shield, PII handling and data-subject requests',
        icon: 'shield',
        href: '/org/privacy',
        group: 'Organisation',
        keywords: ['gdpr', 'pii', 'dsr', 'shield', 'redaction', 'compliance'],
    },
    {
        id: 'webpages',
        label: 'Webpages',
        hint: 'Published pages, their links and how they are doing',
        icon: 'layout',
        href: '/webpages',
        group: 'Organisation',
        keywords: ['site', 'page', 'publish', 'cms', 'analytics'],
    },
    {
        id: 'forms',
        i18nKey: 'sidebar.forms',
        label: 'Forms',
        hint: 'Shareable forms and the responses that came back',
        icon: 'clipboard',
        href: '/forms',
        group: 'Organisation',
        keywords: ['survey', 'submission', 'response', 'intake'],
    },
    {
        id: 'mcp',
        label: 'MCP servers',
        hint: 'Connected tool servers and their access tokens',
        icon: 'server',
        href: '/mcp',
        group: 'Organisation',
        keywords: ['model context protocol', 'tools', 'token'],
    },
    {
        id: 'integrations',
        i18nKey: 'settings.integrations',
        label: 'Integrations',
        hint: 'Connect Google, Microsoft and the rest',
        icon: 'link',
        href: '/integrations',
        group: 'Organisation',
        keywords: ['google', 'microsoft', 'gmail', 'outlook', 'connect', 'oauth', 'nextcloud'],
    },
    {
        id: 'usage',
        weight: 'primary',
        label: 'Usage and spend',
        hint: 'What has been used this period, and what it cost',
        icon: 'bar-chart-2',
        href: '/usage',
        group: 'Organisation',
        keywords: ['cost', 'tokens', 'quota', 'billing', 'plan', 'limit'],
    },
    {
        id: 'admin',
        i18nKey: 'sidebar.admin',
        label: 'Administration',
        hint: 'Instance health, licences and modules',
        icon: 'sliders',
        href: '/admin',
        group: 'Organisation',
        requires: 'admin_security',
        keywords: ['license', 'modules', 'maintenance', 'operator'],
    },

    // ── Account
    {
        id: 'settings',
        i18nKey: 'sidebar.settings',
        weight: 'primary',
        label: 'Settings',
        hint: 'Everything about this app and this account',
        icon: 'settings',
        href: '/settings',
        group: 'Account',
        keywords: ['preferences', 'options'],
    },
    {
        id: 'appearance',
        i18nKey: 'settings.appearance',
        weight: 'hidden',
        label: 'Appearance',
        hint: 'Theme, accent and how the app looks',
        icon: 'droplet',
        href: '/settings/appearance',
        group: 'Account',
        keywords: ['theme', 'dark', 'light', 'colour', 'color', 'glass'],
    },
    {
        id: 'account',
        i18nKey: 'settings.account',
        weight: 'hidden',
        label: 'Account',
        hint: 'Name, avatar, password and your data',
        icon: 'user',
        href: '/settings/account',
        group: 'Account',
        keywords: ['profile', 'password', 'email', 'export', 'delete'],
    },
    {
        id: 'security',
        i18nKey: 'settings.security',
        weight: 'hidden',
        label: 'Security',
        hint: 'App lock, two-factor and encryption',
        icon: 'lock',
        href: '/settings/security',
        group: 'Account',
        keywords: ['2fa', 'mfa', 'biometrics', 'fingerprint', 'encryption', 'recovery'],
    },
    {
        id: 'notification-settings',
        i18nKey: 'settings.notifications',
        weight: 'hidden',
        label: 'Notification settings',
        hint: 'What Bee Flow tells you about, and when',
        icon: 'bell',
        href: '/settings/notifications',
        group: 'Account',
        keywords: ['push', 'alerts', 'quiet'],
    },
    {
        id: 'language',
        i18nKey: 'settings.language',
        weight: 'hidden',
        label: 'Language',
        hint: 'The language Bee Flow speaks to you in',
        icon: 'globe',
        href: '/settings/language',
        group: 'Account',
        keywords: ['locale', 'translation', 'nederlands', 'english'],
    },
    {
        id: 'server',
        weight: 'hidden',
        label: 'Server',
        hint: 'Which Bee Flow this app talks to',
        icon: 'server',
        href: '/settings/server',
        group: 'Account',
        keywords: ['host', 'url', 'self-host', 'connection', 'switch'],
    },

    // ── Help
    {
        id: 'support',
        label: 'Help and support',
        hint: 'Ask a question and track the answer',
        icon: 'life-buoy',
        href: '/support',
        group: 'Help',
        keywords: ['ticket', 'contact', 'question', 'problem', 'bug'],
    },
    {
        id: 'about',
        weight: 'hidden',
        label: 'About Bee Flow',
        hint: 'Version, licences and what changed',
        icon: 'info',
        href: '/settings/about',
        group: 'Help',
        keywords: ['version', 'build', 'changelog', 'release notes', 'open source'],
    },
    {
        id: 'docs',
        label: 'Documentation',
        hint: 'Guides and reference, in your browser',
        icon: 'external-link',
        href: 'https://docs.beeflow.ai/',
        group: 'Help',
        external: true,
        keywords: ['docs', 'manual', 'help', 'guide'],
    },
];

/**
 * Substring match over a destination's words — in the user's language AND in
 * English, always both.
 *
 * The haystack used to be English literals only. That was invisible while
 * nothing but the More tab used it, and would have become the central defect
 * the moment the header magnifier started answering "where is X": this
 * product's primary users work in Dutch, so the one instrument built to end the
 * hunting would have returned nothing for every word they actually typed.
 *
 * Both languages, never one, for two reasons. A Dutch user who has picked up
 * the English product noun — everybody says "dashboard" — still finds it. And
 * an untranslated key falls back to its English literal, so a half-translated
 * catalogue degrades to today's behaviour instead of to silence.
 */
export function matchesSearch(
    destination: Destination,
    query: string,
    /** Omit for English-only matching; pass `t` from useTranslation for both. */
    translate?: (key: string, fallback: string) => string,
): boolean {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;

    const words = [destination.label, destination.hint, ...(destination.keywords ?? [])];
    if (translate && destination.i18nKey) {
        words.push(translate(destination.i18nKey, destination.label));
    }
    return words.join(' ').toLowerCase().includes(needle);
}

/**
 * Hide only what is certainly out of reach.
 *
 * `permissions` is the array from `/auth/my-permissions`; 'all' is the
 * super-permission. Every destination without a `requires` stays — see the
 * header for why erring towards visible is the right default here.
 */
export function isReachable(
    destination: Destination,
    permissions: readonly string[] | null,
    isAdmin: boolean,
): boolean {
    if (!destination.requires) return true;
    if (isAdmin) return true;
    if (!permissions) return false;
    return permissions.includes('all') || permissions.includes(destination.requires);
}
