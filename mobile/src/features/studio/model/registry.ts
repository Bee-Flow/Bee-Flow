/**
 * The Studio registry: every section the web's Studio has, in its order,
 * under its heading, behind its gate — a port of STUDIO_APPS in
 * agent-hub/src/components/admin/Studio/studioApps.jsx, pinned to it by
 * studioSections.lockstep.test.ts (ids, order, categories, icons, kinds,
 * label keys, count keys, gate ids, locks and the New-menu entries).
 *
 * What the web file holds that this does not: the lazy screen and its props.
 * What this holds that the web does not: `target`, where the section opens on
 * a phone. Every section has a native screen; the `web` target stays in the
 * vocabulary for a runtime module or a section a future web release adds.
 * The New menu: an agent, an automation and a form open their own create
 * screens (`/agents/new?ai=1`, `/automations/new`, `/forms/new`); every other
 * kind opens the list screen that hosts its create flow, with `?new=1`
 * (`?create=1` for Solutions) where that screen opens the flow straight away.
 *
 * Pure data: the drawer, the Studio hub and the deep-link lockstep all read it.
 */

import type {
    StudioCategory,
    StudioCreate,
    StudioSection,
    StudioSectionId,
    StudioTarget,
} from './types';

/** STUDIO_CATEGORIES: order here IS the order of the headings. */
export const STUDIO_CATEGORIES: readonly StudioCategory[] = [
    { id: 'build', labelKey: 'studio.category.build', labelFallback: 'Build' },
    { id: 'ai', labelKey: 'studio.category.ai', labelFallback: 'AI' },
    { id: 'bundle', labelKey: 'studio.category.bundle', labelFallback: 'Bundle' },
    { id: 'modules', labelKey: 'studio.category.modules', labelFallback: 'Add-ons' },
];

const route = (href: string, detail?: (id: string) => string): StudioTarget =>
    detail ? { kind: 'route', href, detail } : { kind: 'route', href };
const under = (base: string) => (id: string) => `${base}/${id}`;
const create = (key: string, fallback: string, target: StudioTarget): StudioCreate => ({
    labelKey: `studio.new.${key}`,
    labelFallback: fallback,
    target,
});

/** The fields most sections share; each entry states only what makes it itself. */
const section = (s: Omit<StudioSection, 'lockOn' | 'hiddenFromNav' | 'gateCapability' | 'create'> &
    Partial<Pick<StudioSection, 'lockOn' | 'hiddenFromNav' | 'gateCapability' | 'create'>>): StudioSection => ({
    lockOn: 'hide',
    hiddenFromNav: false,
    gateCapability: null,
    create: null,
    ...s,
});

/** The gate Automations, Datatables and Forms share: one mount, one entitlement. */
const AUTOMATIONS = { license: ['automations'], canUse: ['automations'] } as const;

export const STUDIO_SECTIONS: readonly StudioSection[] = [
    section({
        id: 'agents', segment: 'agents', category: 'ai', icon: 'Bot', kind: 'agent', countKey: 'agents',
        labelKey: 'studio.tab.agents', labelFallback: 'Agents',
        descKey: 'studio.tab.agents_desc', descFallback: 'Create and manage your agents',
        requires: { perms: ['manage_agents'] },
        // "New" opens the phone's own create flow, as the Agents list's New
        // menu does: "Create with AI" (app/agents/new.tsx, `?ai=1`), which is
        // where the web's AgentStudio root lands too.
        create: create('agent', 'Agent', route('/agents/new?ai=1')),
        target: route('/agents', under('/agents')),
    }),
    section({
        id: 'skills', segment: 'skills', category: 'ai', icon: 'Sparkles', kind: 'skill', countKey: 'skills',
        labelKey: 'studio.tab.skills', labelFallback: 'Skills',
        descKey: 'studio.tab.skills_desc', descFallback: 'Reusable abilities for your agents',
        requires: { can: ['skills'], perms: ['manage_skills'] },
        gateCapability: 'skills', lockOn: 'disable',
        create: create('skill', 'Skill', route('/skills?new=1')),
        target: route('/skills', under('/skills')),
    }),
    section({
        id: 'knowledge', segment: 'knowledge', category: 'ai', icon: 'BookOpen', kind: 'kb', countKey: 'knowledge',
        labelKey: 'studio.tab.knowledge', labelFallback: 'Knowledge',
        descKey: 'studio.tab.knowledge_desc', descFallback: 'Knowledge bases your AI can search',
        requires: { perms: ['manage_knowledge'] },
        create: create('knowledge', 'Knowledge base', route('/knowledge?new=1')),
        target: route('/knowledge', under('/knowledge')),
    }),
    section({
        id: 'aiTasks', segment: 'automations', legacySegments: ['routines', 'ai-tasks'],
        category: 'build', icon: 'ListChecks', kind: 'automation',
        countKey: 'automations',
        labelKey: 'studio.tab.automations', labelFallback: 'Automations',
        descKey: 'studio.tab.automations_desc', descFallback: 'Multi-step automations that run for you',
        requires: { ...AUTOMATIONS, perms: ['use_automations'] },
        gateCapability: 'automations', lockOn: 'disable',
        // New opens the flow editor's new-automation screen: the automation is
        // created on its first edit.
        create: create('automation', 'Automation', route('/automations/new')),
        target: route('/automations', under('/automations')),
    }),
    section({
        id: 'approvals', segment: 'approvals', category: 'build', icon: 'ShieldCheck', kind: null,
        countKey: 'approvals',
        labelKey: 'studio.tab.approvals', labelFallback: 'Approvals',
        descKey: 'studio.tab.approvals_desc', descFallback: 'Requests waiting on a person, and every past decision',
        requires: { license: ['approvals'], perms: ['use_approvals'] },
        // Deciding is a member act: Approvals has its own drawer row.
        hiddenFromNav: true,
        target: route('/approvals', under('/approvals')),
    }),
    section({
        id: 'datatables', segment: 'datatables', category: 'build', icon: 'Table2', kind: 'datatable',
        countKey: 'datatables',
        labelKey: 'studio.tab.datatables', labelFallback: 'Datatables',
        descKey: 'studio.tab.datatables_desc', descFallback: 'Rows your automations keep between runs',
        requires: { ...AUTOMATIONS, perms: ['use_datatables'] },
        gateCapability: 'automations', lockOn: 'disable',
        create: create('datatable', 'Table', route('/datatables?new=1')),
        target: route('/datatables', under('/datatables')),
    }),
    section({
        id: 'webpages', segment: 'webpages', category: 'build', icon: 'Globe', kind: 'webpage', countKey: 'webpages',
        labelKey: 'studio.tab.webpages', labelFallback: 'Webpages',
        descKey: 'studio.tab.webpages_desc', descFallback: 'Design and publish public webpages',
        requires: { license: ['webpages'], canUse: ['webpages'], perms: ['use_webpages'] },
        gateCapability: 'webpages', lockOn: 'disable',
        // The builder chat, sources, versions, settings and sharing are native.
        create: create('webpage', 'Webpage', route('/webpages?new=1')),
        target: route('/webpages', under('/webpages')),
    }),
    section({
        id: 'documents', segment: 'documents', category: 'build', icon: 'FileText', kind: 'document',
        countKey: 'documents',
        labelKey: 'studio.tab.documents', labelFallback: 'Documents',
        descKey: 'studio.tab.documents_desc',
        descFallback: 'Pages, notebooks, invoices, quotes and letters — editable by hand, downloadable as PDF',
        requires: {},
        // app/documents is Studio Documents; the knowledge-base file list
        // lives at /knowledge/documents.
        create: create('document', 'Document', route('/documents?new=1')),
        target: route('/documents', under('/documents')),
    }),
    section({
        id: 'apps', segment: 'apps', category: 'build', icon: 'LayoutGrid', kind: 'app', countKey: 'apps',
        labelKey: 'studio.tab.apps', labelFallback: 'Apps',
        descKey: 'studio.tab.apps_desc', descFallback: 'Build and publish internal apps',
        requires: { license: ['app_studio'], canUse: ['app_studio'], perms: ['manage_apps'] },
        gateCapability: 'app_studio', lockOn: 'disable',
        // Building apps on the phone is not there yet: the section and its New
        // entry open the App Studio coming-soon screen, which runs an app on request.
        create: create('app', 'App', route('/studio/apps')),
        // An app itself opens in the runner, on the owner's draft (a Studio
        // app is usually yours and often unpublished); the section and New
        // still explain that building apps is not on the phone yet.
        target: route('/studio/apps', (id) => `/apps/${id}?draft=1`),
    }),
    section({
        id: 'forms', segment: 'forms', category: 'build', icon: 'ClipboardList', kind: 'form', countKey: 'forms',
        labelKey: 'sidebar.forms', labelFallback: 'Forms',
        descKey: 'studio.tab.forms_desc', descFallback: 'Published forms, and what they start',
        requires: { ...AUTOMATIONS, perms: ['use_automations'] },
        gateCapability: 'automations', lockOn: 'disable',
        create: create('form', 'Form', route('/forms/new')),
        // The web's `/studio/forms/<id>` is the AUTOMATION's id, and so is the
        // phone's Form page (/forms/<id>); the page token never travels.
        target: route('/forms', under('/forms')),
    }),
    section({
        id: 'playbooks', segment: 'playbooks', category: 'bundle', icon: 'Clapperboard', kind: 'playbook',
        countKey: 'playbooks',
        labelKey: 'studio.tab.playbooks', labelFallback: 'Playbooks',
        descKey: 'studio.tab.playbooks_desc',
        descFallback: 'Watch the AI build a table, an automation and an app — one phase at a time',
        requires: { license: ['automations', 'app_studio'], canUse: ['automations', 'app_studio'] },
        gateCapability: 'app_studio', lockOn: 'disable',
        create: create('playbook', 'Playbook', route('/playbooks?new=1')),
        target: route('/playbooks', under('/playbooks')),
    }),
    section({
        id: 'solutions', segment: 'solutions', category: 'bundle', icon: 'Boxes', kind: 'solution',
        countKey: 'solutions',
        labelKey: 'studio.tab.solutions', labelFallback: 'Solutions',
        descKey: 'studio.tab.solutions_desc',
        descFallback: 'Bundle automations, apps and webpages into one installable Solution',
        requires: { license: ['projects'], perms: ['use_solutions'] },
        gateCapability: 'projects', lockOn: 'disable',
        // A Solution is a project seen from the builder's side.
        create: create('solution', 'Solution', route('/projects?create=1')),
        target: route('/projects', under('/projects')),
    }),
    section({
        id: 'runs', segment: 'runs', category: 'bundle', icon: 'History', kind: null, countKey: 'runs',
        labelKey: 'runs.title', labelFallback: 'Runs & log',
        descKey: 'runs.tab_desc', descFallback: 'Every time an automation fired, and what happened',
        requires: AUTOMATIONS,
        gateCapability: 'automations', lockOn: 'disable',
        // The org-wide log with its facets. A run has no page of its own: a
        // row opens its automation's runs (/automations/<id>/runs).
        target: route('/runs'),
    }),
    section({
        id: 'meetingNotes', segment: 'meeting-notes', category: 'ai', icon: 'Mic', kind: 'meeting',
        countKey: 'meetingNotes',
        labelKey: 'studio.tab.meeting_notes', labelFallback: 'Meeting Notes',
        descKey: 'studio.tab.meeting_notes_desc', descFallback: 'Transcripts, speakers and actions',
        requires: { license: ['meeting_notes'], canUse: ['meeting_notes'], perms: ['use_meeting_notes'] },
        gateCapability: 'meeting_notes', lockOn: 'disable',
        // Creating one IS the capture flow, and on the phone that is the Meeting Notes tab.
        create: create('meeting', 'Record or upload a meeting', route('/record')),
        target: route('/record', (id) => `/recordings/${id}`),
    }),
];

/** One section by its web id. */
export function studioSection(id: StudioSectionId): StudioSection {
    return STUDIO_SECTIONS.find((s) => s.id === id) as StudioSection;
}

/**
 * The section a `/app/studio/<segment>` address names, or null. Like the
 * web's studioRoutes.js it accepts the canonical segment, a legacy one and the
 * section id itself (`aiTasks`, `meetingNotes`).
 */
export function sectionForSegment(segment: string | undefined): StudioSection | null {
    if (!segment) return null;
    return (
        STUDIO_SECTIONS.find(
            (s) => s.segment === segment || s.id === segment || (s.legacySegments ?? []).includes(segment),
        ) ?? null
    );
}
