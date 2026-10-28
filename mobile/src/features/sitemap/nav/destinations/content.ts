/**
 * The Content group: what you and your agents read, write and run. Order here
 * is the order the map lists them in.
 */

import { destination } from '../destination';
import type { Destination } from '../types';

export const CONTENT: Destination[] = [
    destination({
        id: 'notebooks',
        label: { i18nKey: 'sidebar.notebooks', en: 'Notebooks' },
        hint: { i18nKey: 'mobile.sitemap.notebooks.hint', en: 'Long-form notes your agents can read' },
        icon: 'FileText',
        href: '/notebooks',
        group: 'Content',
        keywords: ['notes', 'writing'],
    }),
    destination({
        id: 'knowledge',
        label: { i18nKey: 'knowledge.title', en: 'Knowledge bases' },
        hint: { i18nKey: 'studio.tab.knowledge_desc', en: 'Knowledge bases your AI can search' },
        icon: 'BookOpen',
        href: '/knowledge',
        group: 'Content',
        keywords: ['kb', 'rag', 'sources', 'retrieval'],
    }),
    destination({
        id: 'documents',
        label: { i18nKey: 'mobile.sitemap.documents.label', en: 'Knowledge documents' },
        hint: { i18nKey: 'mobile.sitemap.documents.hint', en: 'Files you have uploaded to your knowledge bases' },
        icon: 'FileText',
        // /documents is Studio Documents (the web's Studio section); the
        // knowledge-base file list moved under /knowledge.
        href: '/knowledge/documents',
        group: 'Content',
        keywords: ['files', 'uploads', 'pdf'],
    }),
    destination({
        id: 'skills',
        label: { i18nKey: 'sidebar.skills', en: 'Skills' },
        hint: { i18nKey: 'studio.tab.skills_desc', en: 'Reusable abilities for your agents' },
        icon: 'Sparkles',
        href: '/skills',
        group: 'Content',
        keywords: ['instructions', 'prompt pack', 'playbook'],
    }),
    destination({
        id: 'memory',
        label: { i18nKey: 'settings.memory', en: 'Memory' },
        hint: { i18nKey: 'settings.memory_desc', en: 'Persisted facts about you, your projects, and preferences' },
        icon: 'Bookmark',
        href: '/memory',
        group: 'Content',
        keywords: ['remember', 'forget', 'recall', 'personalisation'],
    }),
    destination({
        id: 'templates',
        label: { i18nKey: 'sidebar.templates', en: 'Templates' },
        hint: { i18nKey: 'mobile.sitemap.templates.hint', en: 'Reusable prompts and starting points' },
        icon: 'Copy',
        href: '/templates',
        group: 'Content',
        keywords: ['prompt', 'starter'],
    }),
    destination({
        id: 'projects',
        label: { i18nKey: 'sidebar.projects', en: 'Projects' },
        hint: { i18nKey: 'mobile.sitemap.projects.hint', en: 'Group chats, files and automations by the work they belong to' },
        icon: 'Folder',
        href: '/projects',
        group: 'Content',
        keywords: ['workspace', 'folder'],
    }),
    destination({
        id: 'apps',
        label: { i18nKey: 'sidebar.apps', en: 'Apps' },
        hint: { i18nKey: 'mobile.sitemap.apps.hint', en: 'Small tools built in App Studio' },
        icon: 'AppWindow',
        href: '/apps',
        group: 'Content',
        keywords: ['studio', 'tools'],
    }),
    destination({
        id: 'approvals',
        label: { i18nKey: 'sidebar.approvals', en: 'Approvals' },
        hint: { i18nKey: 'studio.tab.approvals_desc', en: 'Requests waiting on a person, and every past decision' },
        icon: 'ShieldCheck',
        href: '/approvals',
        group: 'Content',
        // Had no row at all until its list screen existed: the only entrance
        // was an unread notification, so a decided approval was unreachable.
        keywords: ['approve', 'reject', 'waiting', 'decision', 'goedkeuren', 'wacht', 'besluit'],
    }),
    destination({
        id: 'automations',
        label: { i18nKey: 'automations.title', en: 'Automations' },
        hint: { i18nKey: 'studio.tab.automations_desc', en: 'Multi-step automations that run for you' },
        icon: 'ListChecks',
        href: '/automations',
        group: 'Content',
        keywords: ['schedule', 'trigger', 'runs', 'workflow'],
    }),
    destination({
        id: 'tasks',
        label: { i18nKey: 'sidebar.tasks', en: 'Tasks and reminders' },
        hint: { i18nKey: 'mobile.sitemap.tasks.hint', en: 'What you asked Bee Flow to come back to you about' },
        icon: 'SquareCheckBig',
        href: '/tasks',
        group: 'Content',
        keywords: ['todo', 'reminder', 'agenda'],
    }),
    destination({
        id: 'datatables',
        label: { i18nKey: 'studio.tab.datatables', en: 'Datatables' },
        hint: { i18nKey: 'studio.tab.datatables_desc', en: 'Rows your automations keep between runs' },
        icon: 'Table2',
        href: '/datatables',
        group: 'Content',
        // Studio's gate: the automations entitlement and `use_datatables`.
        gate: { license: 'automations', canUse: 'automations', perms: ['use_datatables'] },
        keywords: ['table', 'rows', 'spreadsheet', 'csv', 'data', 'tabel'],
    }),
    destination({
        id: 'studio-documents',
        label: { i18nKey: 'mobile.sitemap.studio_documents.label', en: 'Studio documents' },
        hint: { i18nKey: 'studio.tab.documents_desc', en: 'Pages, notebooks, invoices, quotes and letters — editable by hand, downloadable as PDF' },
        icon: 'FileText',
        href: '/documents',
        group: 'Content',
        keywords: ['invoice', 'quote', 'letter', 'presentation', 'deck', 'pdf', 'factuur', 'offerte', 'brief'],
    }),
    destination({
        id: 'runs',
        label: { i18nKey: 'runs.title', en: 'Runs & log' },
        hint: { i18nKey: 'runs.tab_desc', en: 'Every time an automation fired, and what happened' },
        icon: 'History',
        href: '/runs',
        group: 'Content',
        keywords: ['executions', 'log', 'history', 'failed', 'uitvoeringen', 'logboek'],
        gate: { license: 'automations', canUse: 'automations' },
    }),
    destination({
        id: 'playbooks',
        label: { i18nKey: 'studio.tab.playbooks', en: 'Playbooks' },
        hint: { i18nKey: 'studio.tab.playbooks_desc', en: 'Watch the AI build a table, an automation and an app — one phase at a time' },
        icon: 'Clapperboard',
        href: '/playbooks',
        group: 'Content',
        keywords: ['build', 'phases', 'recipe', 'bouwen'],
        gate: { can: 'app_studio', canUse: 'automations' },
    }),
];
