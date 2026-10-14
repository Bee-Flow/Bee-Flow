import { documentRefOf } from '../pages/documents/notebookRef';

/** Where Studio is: a section, optionally one item in it, and the deep-link
 *  extras the URL carries (tab, sub-item, builder query state, origin). */
export interface StudioRoute {
    section: string;
    id?: string | null;
    sub?: string | null;
    subId?: string | null;
    automationKind?: string | null;
    view?: string | null;
    runId?: string | null;
    stepId?: string | null;
    from?: string | null;
}

/** `value` when Studio is on `section`, null on any other section. */
const onSection = <T>(route: StudioRoute, section: string | string[], value: () => T): T | null => (
    (Array.isArray(section) ? section.includes(route.section) : route.section === section) ? value() : null
);

/**
 * The deep-link props Studio is opened with, read off the route. Each section
 * hands over only its own id (and tab); every other `initial*` prop is null.
 */
export function studioRouteProps(studioRoute: StudioRoute) {
    const id = () => studioRoute.id;
    const sub = () => studioRoute.sub || null;
    const isStep = studioRoute.automationKind === 'step';
    return {
        initialAgentId: onSection(studioRoute, 'agents', id),
        initialSkillId: onSection(studioRoute, 'skills', id),
        initialKbId: onSection(studioRoute, 'knowledge', id),
        initialKbTab: onSection(studioRoute, 'knowledge', sub),
        initialSourceId: onSection(studioRoute, 'knowledge', () => studioRoute.subId || null),
        initialTaskId: isStep ? null : onSection(studioRoute, 'aiTasks', id),
        initialStepId: isStep ? onSection(studioRoute, 'aiTasks', id) : null,
        initialFlowletKey: onSection(studioRoute, 'aiTasks', sub),
        initialWebpageId: onSection(studioRoute, 'webpages', id),
        initialDocumentId: onSection(studioRoute, 'documents', () => documentRefOf(studioRoute)),
        initialStudioAppId: onSection(studioRoute, 'apps', id),
        // Meeting Notes accepts a deep link too, so the sidebar's
        // "recently edited" rows can land on the transcript itself
        // and not just on the section.
        initialMeetingId: onSection(studioRoute, 'meetingNotes', id),
        initialApprovalId: onSection(studioRoute, 'approvals', id),
        initialSolutionId: onSection(studioRoute, 'solutions', id),
        initialDatatableId: onSection(studioRoute, 'datatables', id),
        initialDatatableTab: onSection(studioRoute, 'datatables', sub),
        // A form is addressed by its AUTOMATION id (never the page
        // token) — Studio → Forms → one form, with its tab.
        initialFormId: onSection(studioRoute, 'forms', id),
        initialFormTab: onSection(studioRoute, 'forms', sub),
        initialPlaybookId: onSection(studioRoute, 'playbooks', id),
        // Builder query state (?view/run/step) — a run deep-link.
        // `?run=` is read for Runs & log as well: that section
        // has no `/:id` path segment (a run is addressed by the
        // same query string the builder uses), so without this
        // a link to one run in the org's log would open the log
        // and drop the run. `?view=` stays builder-only — the
        // Runs section has no views to switch between.
        initialBuilderView: onSection(studioRoute, 'aiTasks', () => studioRoute.view || null),
        initialRunId: onSection(studioRoute, ['aiTasks', 'runs'], () => studioRoute.runId || null),
        initialRunStepId: onSection(studioRoute, ['aiTasks', 'runs'], () => studioRoute.stepId || null),
        // ?from=app:… — the button in an app this builder was
        // opened from, for the breadcrumb back (P4). Builder
        // only: no other section has a trail to draw.
        initialFrom: onSection(studioRoute, 'aiTasks', () => studioRoute.from || null),
    };
}
