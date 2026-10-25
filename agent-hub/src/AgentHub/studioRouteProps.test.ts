import { describe, expect, it } from 'vitest';
import { notebookRef } from '../pages/documents/notebookRef';
import { studioRouteProps, type StudioRoute } from './studioRouteProps';

// The mapping exactly as AgentHub.jsx spelled it inline before the split, kept
// here as the reference the extracted helper must agree with on every route.
const documentRef = (r: StudioRoute) => (r.id === 'notebook' ? (r.sub ? notebookRef(r.sub) : null) : r.id || null);
const reference = (r: StudioRoute) => ({
    initialAgentId: r.section === 'agents' ? r.id : null,
    initialSkillId: r.section === 'skills' ? r.id : null,
    initialKbId: r.section === 'knowledge' ? r.id : null,
    initialKbTab: r.section === 'knowledge' ? (r.sub || null) : null,
    initialSourceId: r.section === 'knowledge' ? (r.subId || null) : null,
    initialTaskId: r.section === 'aiTasks' && r.automationKind !== 'step' ? r.id : null,
    initialStepId: r.section === 'aiTasks' && r.automationKind === 'step' ? r.id : null,
    initialFlowletKey: r.section === 'aiTasks' ? (r.sub || null) : null,
    initialWebpageId: r.section === 'webpages' ? r.id : null,
    initialDocumentId: r.section === 'documents' ? documentRef(r) : null,
    initialStudioAppId: r.section === 'apps' ? r.id : null,
    initialMeetingId: r.section === 'meetingNotes' ? r.id : null,
    initialApprovalId: r.section === 'approvals' ? r.id : null,
    initialSolutionId: r.section === 'solutions' ? r.id : null,
    initialDatatableId: r.section === 'datatables' ? r.id : null,
    initialDatatableTab: r.section === 'datatables' ? (r.sub || null) : null,
    initialFormId: r.section === 'forms' ? r.id : null,
    initialFormTab: r.section === 'forms' ? (r.sub || null) : null,
    initialPlaybookId: r.section === 'playbooks' ? r.id : null,
    initialBuilderView: r.section === 'aiTasks' ? (r.view || null) : null,
    initialRunId: r.section === 'aiTasks' || r.section === 'runs' ? (r.runId || null) : null,
    initialRunStepId: r.section === 'aiTasks' || r.section === 'runs' ? (r.stepId || null) : null,
    initialFrom: r.section === 'aiTasks' ? (r.from || null) : null,
});

const SECTIONS = ['agents', 'skills', 'knowledge', 'aiTasks', 'webpages', 'documents', 'apps', 'meetingNotes',
    'approvals', 'solutions', 'datatables', 'forms', 'playbooks', 'runs', 'somethingElse'];

describe('studioRouteProps', () => {
    it('agrees with the inline mapping on every section and shape of route', () => {
        const shapes: Array<Omit<StudioRoute, 'section'>> = [
            {},
            { id: null },
            { id: 'x1' },
            { id: 'x1', sub: 'tab', subId: 's1', view: 'v', runId: 'r1', stepId: 'st1', from: 'app:a' },
            { id: 'x2', automationKind: 'step', sub: '' },
            { id: 'notebook', sub: 'nb1' },
            { id: 'notebook' },
        ];
        for (const section of SECTIONS) {
            for (const shape of shapes) {
                const route = { section, ...shape };
                expect(studioRouteProps(route), JSON.stringify(route)).toEqual(reference(route));
            }
        }
    });

    it('passes an absent id through as undefined, as the inline code did', () => {
        const props = studioRouteProps({ section: 'agents' });
        expect('initialAgentId' in props).toBe(true);
        expect(props.initialAgentId).toBeUndefined();
        expect(props.initialSkillId).toBeNull();
    });
});
