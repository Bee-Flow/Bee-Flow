/**
 * The Workspace group: the tabs, the drawer's core rows and the things you
 * reach for from anywhere. Order here is the order the map lists them in.
 *
 * Listed even though they are one tap away in the tab bar or the drawer,
 * because the map is meant to be the whole map — a person who comes looking
 * for "recordings" should find it, not be told to look at the tab bar they
 * already looked at.
 */

import { destination } from '../destination';
import type { Destination } from '../types';

export const WORKSPACE: Destination[] = [
    destination({
        id: 'chat',
        label: { i18nKey: 'mobile.sitemap.chat.label', en: 'Chat' },
        hint: { i18nKey: 'mobile.sitemap.chat.hint', en: 'Start something new, and your recent conversations' },
        icon: 'MessageSquare',
        href: '/',
        group: 'Workspace',
        keywords: ['conversation', 'agent', 'ai', 'assistant', 'nieuw', 'gesprek'],
    }),
    destination({
        id: 'chats',
        label: { i18nKey: 'sidebar.chats', en: 'All conversations' },
        hint: { i18nKey: 'mobile.sitemap.chats.hint', en: 'Every chat, grouped by when you last touched it' },
        icon: 'MessageCircle',
        href: '/chats',
        group: 'Workspace',
        // The full list stopped being the Chat tab's root when the composer
        // took that slot, so it needs a row of its own — a screen reachable
        // only by knowing a footer link exists is a screen nobody finds.
        keywords: ['history', 'archive', 'past', 'gesprekken', 'geschiedenis'],
    }),
    destination({
        id: 'record',
        label: { i18nKey: 'sidebar.meeting_notes', en: 'Meeting Notes' },
        hint: { i18nKey: 'mobile.sitemap.record.hint', en: 'Record, upload and read your meetings, with insights' },
        icon: 'Mic',
        href: '/record',
        group: 'Workspace',
        keywords: ['record', 'meeting', 'transcribe', 'transcription', 'audio', 'voice', 'notes', 'insights', 'vergadering'],
    }),
    destination({
        id: 'library',
        label: { i18nKey: 'mobile.sitemap.library.label', en: 'Library' },
        hint: { i18nKey: 'mobile.sitemap.library.hint', en: 'Notebooks, knowledge, documents, templates and house styles together' },
        icon: 'BookOpen',
        // Was a tab. The drawer and Studio carry each of its parts now, and
        // the hub itself (house styles live only here) is a pushed screen.
        href: '/library',
        group: 'Workspace',
        keywords: ['notebooks', 'knowledge', 'documents'],
    }),
    destination({
        id: 'cowork',
        label: { i18nKey: 'sidebar.cowork', en: 'Cowork' },
        hint: { i18nKey: 'mobile.sitemap.cowork.hint', en: 'Work you handed over, that runs without you' },
        icon: 'Handshake',
        href: '/cowork',
        group: 'Workspace',
        // 'automate' stays in the keywords, not the label. The tab is named
        // for the web's word now, but anybody who learned this app before the
        // rename still types the old one — and the whole point of the search
        // corpus is that it answers the word in the person's head.
        keywords: [
            'automate', 'automation', 'schedule', 'workflow', 'delegate',
            'recurring', 'samenwerken', 'gepland', 'taken',
        ],
    }),
    destination({
        id: 'studio',
        label: { i18nKey: 'studio.sidebar_link', en: 'Studio' },
        hint: { i18nKey: 'mobile.sitemap.studio.hint', en: 'Everything you build: automations, apps, agents, knowledge and more' },
        icon: 'LayoutGrid',
        href: '/studio',
        group: 'Workspace',
        keywords: ['build', 'builder', 'create', 'new', 'maken', 'bouwen'],
    }),
    destination({
        id: 'studio-search',
        label: { i18nKey: 'studio.search.title', en: 'Search Studio' },
        hint: { i18nKey: 'mobile.sitemap.studio_search.hint', en: 'Find an automation, app, agent or table by its name' },
        icon: 'Search',
        href: '/studio/search',
        group: 'Workspace',
        keywords: ['find', 'zoeken', 'lookup'],
    }),
    destination({
        id: 'studio-attention',
        label: { i18nKey: 'studio.attention.title', en: 'Needs attention' },
        hint: { i18nKey: 'mobile.sitemap.studio_attention.hint', en: 'What in Studio is broken or waiting on someone' },
        icon: 'TriangleAlert',
        href: '/studio/attention',
        group: 'Workspace',
        keywords: ['problems', 'warnings', 'errors', 'validation', 'aandacht'],
    }),
    destination({
        id: 'app-studio',
        label: { i18nKey: 'mobile.sitemap.app_studio.label', en: 'App Studio' },
        hint: { i18nKey: 'mobile.sitemap.app_studio.hint', en: 'Build apps: coming soon on the phone' },
        icon: 'LayoutGrid',
        href: '/studio/apps',
        group: 'Workspace',
        keywords: ['build', 'builder', 'apps', 'coming soon'],
    }),
    destination({
        id: 'agents',
        label: { i18nKey: 'sidebar.agents', en: 'Agents' },
        hint: { i18nKey: 'mobile.sitemap.agents.hint', en: 'Every agent you can open, and the chats you had with them' },
        icon: 'Store',
        href: '/agents',
        group: 'Workspace',
        keywords: ['agent hub', 'assistant', 'bot', 'favourites', 'favorites', 'published'],
    }),
    destination({
        id: 'voice',
        label: { i18nKey: 'chat.voice.title', en: 'Voice mode' },
        hint: { i18nKey: 'mobile.sitemap.voice.hint', en: 'Talk to Bee Flow and hear it answer' },
        icon: 'Mic',
        href: '/voice',
        group: 'Workspace',
        // Not gated: voice needs a server capability AND a
        // configured Mistral key, and the screen itself explains which of the
        // two is missing and who can fix it. Hiding the row would leave a
        // self-hoster with no way to find out the feature exists.
        keywords: ['speak', 'talk', 'speech', 'spoken', 'hands free', 'call'],
    }),
    destination({
        id: 'search',
        label: { i18nKey: 'sidebar.search', en: 'Search everything' },
        hint: { i18nKey: 'mobile.sitemap.search.hint', en: 'One search across chats, documents and knowledge' },
        icon: 'Search',
        href: '/search',
        group: 'Workspace',
        keywords: ['find', 'lookup'],
    }),
    destination({
        id: 'notifications',
        label: { i18nKey: 'notifications.title', en: 'Notifications' },
        hint: { i18nKey: 'mobile.sitemap.notifications.hint', en: 'What finished, what needs you' },
        icon: 'Bell',
        href: '/notifications',
        group: 'Workspace',
        keywords: ['alerts', 'inbox'],
    }),
    destination({
        id: 'summary-templates',
        label: { i18nKey: 'mobile.sitemap.summary_templates.label', en: 'Summary templates' },
        hint: { i18nKey: 'mobile.sitemap.summary_templates.hint', en: 'The saved styles Meeting Notes writes its summaries in' },
        icon: 'LayoutTemplate',
        href: '/meeting-templates',
        group: 'Workspace',
        keywords: ['meeting', 'regenerate', 'prompt', 'samenvatting', 'sjabloon'],
    }),
    destination({
        id: 'upcoming-meetings',
        label: { i18nKey: 'mobile.sitemap.upcoming_meetings.label', en: 'Upcoming meetings' },
        hint: { i18nKey: 'mobile.sitemap.upcoming_meetings.hint', en: 'Talk and Meet meetings, and which ones get recorded' },
        icon: 'CalendarClock',
        href: '/upcoming-meetings',
        group: 'Workspace',
        keywords: ['meeting', 'calendar', 'auto-record', 'talk', 'google meet', 'gepland', 'opnemen'],
    }),
    destination({
        id: 'meeting-imports',
        label: { i18nKey: 'mobile.sitemap.meeting_imports.label', en: 'Import a meeting recording' },
        hint: { i18nKey: 'mobile.sitemap.meeting_imports.hint', en: 'Transcribe a Talk call, a Nextcloud audio file or a Meet recording' },
        icon: 'Import',
        href: '/meeting-imports',
        group: 'Workspace',
        keywords: ['meeting', 'nextcloud', 'talk', 'google meet', 'recording', 'importeren', 'opname'],
    }),
    destination({
        id: 'meeting-rules',
        label: { i18nKey: 'mobile.sitemap.meeting_rules.label', en: 'Meeting rules' },
        hint: { i18nKey: 'mobile.sitemap.meeting_rules.hint', en: 'What runs by itself once a meeting note is ready' },
        icon: 'Workflow',
        href: '/meeting-rules',
        group: 'Workspace',
        keywords: ['meeting', 'automation', 'trigger', 'rule', 'regels', 'automatisering'],
    }),
];
