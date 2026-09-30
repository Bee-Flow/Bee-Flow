/**
 * The Workspace group: the tabs, the drawer's core rows and the things you
 * reach for from anywhere. Order here is the order the map lists them in.
 *
 * Listed even though they are one tap away in the tab bar or the drawer,
 * because the map is meant to be the whole map — a person who comes looking
 * for "recordings" should find it, not be told to look at the tab bar they
 * already looked at.
 */

import type { Destination } from '../types';

export const WORKSPACE: Destination[] = [
    {
        id: 'chat',
        label: 'Chat',
        hint: 'Start something new, and your recent conversations',
        icon: 'MessageSquare',
        href: '/',
        group: 'Workspace',
        keywords: ['conversation', 'agent', 'ai', 'assistant', 'nieuw', 'gesprek'],
    },
    {
        id: 'chats',
        i18nKey: 'sidebar.chats',
        label: 'All conversations',
        hint: 'Every chat, grouped by when you last touched it',
        icon: 'MessageCircle',
        href: '/chats',
        group: 'Workspace',
        // The full list stopped being the Chat tab's root when the composer
        // took that slot, so it needs a row of its own — a screen reachable
        // only by knowing a footer link exists is a screen nobody finds.
        keywords: ['history', 'archive', 'past', 'gesprekken', 'geschiedenis'],
    },
    {
        id: 'record',
        label: 'Meeting Notes',
        hint: 'Record, upload and read your meetings, with insights',
        icon: 'Mic',
        href: '/record',
        group: 'Workspace',
        keywords: ['record', 'meeting', 'transcribe', 'transcription', 'audio', 'voice', 'notes', 'insights', 'vergadering'],
    },
    {
        id: 'library',
        label: 'Library',
        hint: 'Notebooks, knowledge, documents, templates and house styles together',
        icon: 'BookOpen',
        // Was a tab. The drawer and Studio carry each of its parts now, and
        // the hub itself (house styles live only here) is a pushed screen.
        href: '/library',
        group: 'Workspace',
        keywords: ['notebooks', 'knowledge', 'documents'],
    },
    {
        id: 'cowork',
        i18nKey: 'sidebar.cowork',
        label: 'Cowork',
        hint: 'Work you handed over, that runs without you',
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
    },
    {
        id: 'studio',
        label: 'Studio',
        hint: 'Everything you build: automations, apps, agents, knowledge and more',
        icon: 'LayoutGrid',
        href: '/studio',
        group: 'Workspace',
        keywords: ['build', 'builder', 'create', 'new', 'maken', 'bouwen'],
    },
    {
        id: 'studio-search',
        label: 'Search Studio',
        hint: 'Find an automation, app, agent or table by its name',
        icon: 'Search',
        href: '/studio/search',
        group: 'Workspace',
        keywords: ['find', 'zoeken', 'lookup'],
    },
    {
        id: 'studio-attention',
        label: 'Needs attention',
        hint: 'What in Studio is broken or waiting on someone',
        icon: 'TriangleAlert',
        href: '/studio/attention',
        group: 'Workspace',
        keywords: ['problems', 'warnings', 'errors', 'validation', 'aandacht'],
    },
    {
        id: 'app-studio',
        label: 'App Studio',
        hint: 'Build apps: coming soon on the phone',
        icon: 'LayoutGrid',
        href: '/studio/apps',
        group: 'Workspace',
        keywords: ['build', 'builder', 'apps', 'coming soon'],
    },
    {
        id: 'agents',
        i18nKey: 'sidebar.agents',
        label: 'Agents',
        hint: 'Every agent you can open, and the chats you had with them',
        icon: 'Store',
        href: '/agents',
        group: 'Workspace',
        keywords: ['agent hub', 'assistant', 'bot', 'favourites', 'favorites', 'published'],
    },
    {
        id: 'voice',
        label: 'Voice mode',
        hint: 'Talk to Bee Flow and hear it answer',
        icon: 'Mic',
        href: '/voice',
        group: 'Workspace',
        // Not gated: voice needs a server capability AND a
        // configured Mistral key, and the screen itself explains which of the
        // two is missing and who can fix it. Hiding the row would leave a
        // self-hoster with no way to find out the feature exists.
        keywords: ['speak', 'talk', 'speech', 'spoken', 'hands free', 'call'],
    },
    {
        id: 'search',
        i18nKey: 'sidebar.search',
        label: 'Search everything',
        hint: 'One search across chats, documents and knowledge',
        icon: 'Search',
        href: '/search',
        group: 'Workspace',
        keywords: ['find', 'lookup'],
    },
    {
        id: 'notifications',
        label: 'Notifications',
        hint: 'What finished, what needs you',
        icon: 'Bell',
        href: '/notifications',
        group: 'Workspace',
        keywords: ['alerts', 'inbox'],
    },
    {
        id: 'summary-templates',
        label: 'Summary templates',
        hint: 'The saved styles Meeting Notes writes its summaries in',
        icon: 'LayoutTemplate',
        href: '/meeting-templates',
        group: 'Workspace',
        keywords: ['meeting', 'regenerate', 'prompt', 'samenvatting', 'sjabloon'],
    },
    {
        id: 'upcoming-meetings',
        label: 'Upcoming meetings',
        hint: 'Talk and Meet meetings, and which ones get recorded',
        icon: 'CalendarClock',
        href: '/upcoming-meetings',
        group: 'Workspace',
        keywords: ['meeting', 'calendar', 'auto-record', 'talk', 'google meet', 'gepland', 'opnemen'],
    },
    {
        id: 'meeting-imports',
        label: 'Import a meeting recording',
        hint: 'Transcribe a Talk call, a Nextcloud audio file or a Meet recording',
        icon: 'Import',
        href: '/meeting-imports',
        group: 'Workspace',
        keywords: ['meeting', 'nextcloud', 'talk', 'google meet', 'recording', 'importeren', 'opname'],
    },
    {
        id: 'meeting-rules',
        label: 'Meeting rules',
        hint: 'What runs by itself once a meeting note is ready',
        icon: 'Workflow',
        href: '/meeting-rules',
        group: 'Workspace',
        keywords: ['meeting', 'automation', 'trigger', 'rule', 'regels', 'automatisering'],
    },
];
