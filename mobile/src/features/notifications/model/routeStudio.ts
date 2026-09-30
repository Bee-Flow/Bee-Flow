/**
 * The Studio half of the deep-link table: where `/app/studio[/<segment>[/<id>]]`
 * opens on the phone. Split out of route.ts, which keeps the rest of the web
 * address space and calls in here for `studio`.
 *
 * The segments and their destinations are the Studio registry's
 * (features/studio/model/registry.ts, the port of the web's STUDIO_APPS);
 * routeStudio.lockstep.test.ts holds this table to it, section by section.
 * It is pinned by a TEST rather than imported, because notifications sits
 * below features that Studio's own screens may one day need, and a runtime
 * import here would close that cycle.
 *
 * Three outcomes:
 *   - a native list or detail screen — every section has one; `…/new` opens
 *     the list with its create flow already open, where the list has one;
 *   - `/studio`, the hub, for Studio itself (`/app/studio`, `/start`);
 *   - `/studio` marked `approximate` for a segment this build does not know
 *     (a runtime module, a section a later web release adds). A link in a
 *     chat answer lands there too: on a phone the web page itself would
 *     bounce to the chat (shared/markdown/links.ts).
 */

import { queryValue } from './query';
import type { NotificationTarget } from './route';

/**
 * A section with a native list and a detail screen. Written as `href:` plus a
 * `detail` template on one line, so src/meta/routes.test.ts still checks
 * every target in these tables against app/.
 */
export interface ListOrDetail {
    href: string;
    detail?: (id: string) => string;
}

export function listOrDetail(section: ListOrDetail, id: string | undefined): NotificationTarget {
    return { href: id && section.detail ? section.detail(id) : section.href };
}

/**
 * Percent-decode ONE path segment for inspection only — never for building an
 * href, which keeps the server's own encoding. A malformed escape is not worth
 * a crash inside a tap handler, so it is handed back untouched.
 */
function decodeSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

/** The Studio hub. */
const HUB: NotificationTarget = { href: '/studio' };

/** A segment this build does not know: the hub, where a module's row opens its web page. */
const HUB_FOR_WEB: NotificationTarget = { href: '/studio', approximate: true };

/**
 * `/app/studio/<segment>/<id>` sections that map one-to-one onto a native
 * list/detail pair. The id is passed on as it arrived (several writers encode
 * it themselves, e.g. projects/completeness.js:98 DEEP_LINK.skill). Keyed by
 * the canonical segment; the registry's legacy segments and section ids are
 * folded onto it by SEGMENT_ALIASES.
 */
const STUDIO_SECTIONS = new Map<string, ListOrDetail>([
    // Minted by projects/completeness.js DEEP_LINK (agents, knowledge, skills).
    ['agents', { href: '/agents', detail: (ref) => `/agents/${ref}` }],
    ['skills', { href: '/skills', detail: (ref) => `/skills/${ref}` }],
    ['knowledge', { href: '/knowledge', detail: (ref) => `/knowledge/${ref}` }],
    // The approval id, never a run id: an App Studio approval has no run.
    ['approvals', { href: '/approvals', detail: (ref) => `/approvals/${ref}` }],
    // The Studio editor address of a webpage (core/appPaths.webpageEditorPath).
    ['webpages', { href: '/webpages', detail: (ref) => `/webpages/${ref}` }],
    // The web's App Studio (editor) addresses. Building apps is not on the phone
    // yet: the section lands on the coming-soon screen, one app in the runner,
    // on its owner's draft.
    ['apps', { href: '/studio/apps', detail: (ref) => `/apps/${ref}?draft=1` }],
    // A Studio form is keyed by its ROUTINE's id on both sides: the Form page.
    ['forms', { href: '/forms', detail: (ref) => `/forms/${ref}` }],
    // Meeting notes: the Meeting Notes tab is the list, /recordings/<id> one note.
    ['meeting-notes', { href: '/(tabs)/record', detail: (ref) => `/recordings/${ref}` }],
    // Minted by projects/completeness.js DEEP_LINK.
    ['datatables', { href: '/datatables', detail: (ref) => `/datatables/${ref}` }],
    // Studio Documents (deckDocument.js, documentBuilderTools.js); the
    // knowledge-base file list is /knowledge/documents, not this.
    ['documents', { href: '/documents', detail: (ref) => `/documents/${ref}` }],
    ['playbooks', { href: '/playbooks', detail: (ref) => `/playbooks/${ref}` }],
    // The org-wide log. `?run=<id>` carries no automation id, and a run has no
    // page of its own on the phone, so every runs link opens the log.
    ['runs', { href: '/runs' }],
]);

/**
 * `/app/studio/<segment>/new` — the web's create address, landing where the
 * registry's New-menu entry does (its `create.target`). A section not listed
 * here has no create flow, so `new` opens its list — never a detail screen
 * for an object called "new".
 */
const NEW_TARGETS: Readonly<Record<string, string>> = {
    agents: '/agents/new?ai=1',
    automations: '/automations/new',
    apps: '/studio/apps',
    forms: '/forms/new',
    'meeting-notes': '/(tabs)/record',
    skills: '/skills?new=1',
    knowledge: '/knowledge?new=1',
    datatables: '/datatables?new=1',
    documents: '/documents?new=1',
    playbooks: '/playbooks?new=1',
    webpages: '/webpages?new=1',
    solutions: '/projects?create=1',
};

/** Older segments and section ids the web still accepts (studioRoutes.js), onto the canonical one. */
const SEGMENT_ALIASES: Readonly<Record<string, string>> = {
    routines: 'automations',
    'ai-tasks': 'automations',
    aiTasks: 'automations',
    meetingNotes: 'meeting-notes',
};

/**
 * `/app/studio/automations/<id>`. `?view=runs` is how the web app opens the
 * run history, and `&run=<runId>` one run in it (server utils/appPaths.js
 * automationRunPath: a finished run, a failed step, an approval's run); the
 * phone's runs screen opens that run with `?runId=` (app/automations/[id]/runs.tsx).
 * A `&step=` has no place on the phone and is dropped.
 */
function studioAutomation(id: string | undefined, query: string): NotificationTarget {
    if (!id) return { href: '/automations' };
    if (queryValue(query, 'view') !== 'runs') return { href: `/automations/${id}` };
    const run = queryValue(query, 'run');
    return { href: run ? `/automations/${id}/runs?runId=${run}` : `/automations/${id}/runs` };
}

/**
 * Solutions — the Studio's word for a project, minted by
 * routes/studio/attentionChecks.js:234 (solutionDeepLink). Its own comment
 * (:222) is the warning this answers: the shared finding kind folds synthetic
 * APPROVAL nodes onto 'solution', so `/app/studio/solutions/approval:xyz` can
 * reach a client and is not a page anywhere.
 *
 * Such an id is deliberately NOT repaired into `/approvals/<rest>`:
 * projects/graph.js:85 mints it as `approval:<ownerType>:<ownerId>:<stepId>`,
 * three fields that do not contain an approval id — /approvals/:id would 404.
 * It goes to the project LIST instead: a list that does not contain the item
 * is a smaller lie than a detail screen that fails to load.
 */
function studioSolution(id: string | undefined): NotificationTarget {
    if (id && decodeSegment(id).startsWith('approval:')) return { href: '/projects' };
    return listOrDetail({ href: '/projects', detail: (ref) => `/projects/${ref}` }, id);
}

/**
 * A datatable's own tab, as the web's DatatableDetail names them and the
 * phone's table screen opens them (`?tab=`): `/app/studio/datatables/<id>/retention`
 * — a form's "retention settings" link — opens that tab, not Columns.
 * datatables.lockstep in routeStudio.lockstep.test.ts holds this list to the screen's.
 */
export const DATATABLE_WEB_TABS: readonly string[] = ['columns', 'rows', 'retention', 'sharing', 'usage'];

function datatableTab(id: string | undefined, tab: string | undefined): NotificationTarget | null {
    if (!id || id === 'new' || !tab || !DATATABLE_WEB_TABS.includes(tab)) return null;
    return { href: `/datatables/${id}?tab=${tab}` };
}

export function studioTarget(raw: string | undefined, id: string | undefined, query: string, tab?: string): NotificationTarget {
    if (!raw || raw === 'start') return HUB;
    const segment = SEGMENT_ALIASES[raw] ?? raw;
    const create = id === 'new' ? NEW_TARGETS[segment] : undefined;
    if (create) return { href: create };
    const onTab = segment === 'datatables' ? datatableTab(id, tab) : null;
    if (onTab) return onTab;
    const mapped = STUDIO_SECTIONS.get(segment);
    if (mapped) return listOrDetail(mapped, id === 'new' ? undefined : id);
    if (segment === 'automations') return studioAutomation(id, query);
    if (segment === 'solutions') return studioSolution(id);
    // A segment this build has never heard of: the hub, not claiming to be exact.
    return HUB_FOR_WEB;
}

/** For the lockstep test: every segment this table answers natively, and the create addresses. */
export const STUDIO_TABLE = {
    native: [...STUDIO_SECTIONS.keys(), 'automations', 'solutions'],
    create: NEW_TARGETS,
    aliases: SEGMENT_ALIASES,
} as const;
