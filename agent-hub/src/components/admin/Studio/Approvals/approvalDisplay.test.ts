// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { approvalOriginText, approvalSourceInfo, approvalStatusChip, productionRouteText } from './approvalDisplay';

const t = (_key: string, fallback: string) => fallback;

const DEPLOYMENT = {
    id: 'ap1', source: 'deployment', stepId: 'stage.prd', deploymentId: 'dep1',
    automationTitle: 'Promote Release 7 of Intake to Production', prompt: 'Promote Release 7 of Intake to Production',
    projectId: 'stage-project', context: { deploymentId: 'dep1', releaseSeq: 7, solutionId: 's1' },
};

describe('approvalSourceInfo: a deployment row', () => {
    it('is labelled "Deployment", carries the request text and links to the Solution pipeline', () => {
        expect(approvalSourceInfo(DEPLOYMENT, t)).toEqual({
            source: 'deployment',
            label: 'Deployment',
            text: 'Promote Release 7 of Intake to Production',
            target: 'studio/solutions/s1?tab=pipeline',
            href: '/app/studio/solutions/s1?tab=pipeline',
        });
    });

    it('uses the key the server seeds, so a translation reaches it', () => {
        const seen: string[] = [];
        approvalSourceInfo(DEPLOYMENT, (key: string, fallback: string) => { seen.push(key); return `[${fallback}]`; });
        expect(seen).toEqual(['approvals.source_deployment']);
    });

    it('falls back to the Solutions overview when the row does not name its Solution', () => {
        const info = approvalSourceInfo({ ...DEPLOYMENT, context: { deploymentId: 'dep1' } }, t);
        expect(info?.target).toBe('studio/solutions');
        expect(info?.href).toBe('/app/studio/solutions');
    });

    it('falls back to the prompt when the title is empty', () => {
        expect(approvalSourceInfo({ ...DEPLOYMENT, automationTitle: '' }, t)?.text).toBe('Promote Release 7 of Intake to Production');
    });

    it('is null for every other source', () => {
        expect(approvalSourceInfo({ source: 'run', automationTitle: 'Weekly digest' }, t)).toBeNull();
        expect(approvalSourceInfo({ source: 'app' }, t)).toBeNull();
        expect(approvalSourceInfo(null, t)).toBeNull();
    });
});

describe('approvalOriginText', () => {
    it('reads "Deployment · <request>" for a deployment', () => {
        expect(approvalOriginText(DEPLOYMENT, t)).toBe('Deployment · Promote Release 7 of Intake to Production');
    });

    it('keeps the old line for an automation: its title, or "Automation" without one', () => {
        expect(approvalOriginText({ source: 'run', automationTitle: 'Weekly digest' }, t)).toBe('Weekly digest');
        expect(approvalOriginText({ source: 'run', automationTitle: '' }, t)).toBe('Automation');
    });
});

describe('approvalStatusChip is unchanged', () => {
    it('still words a pending row as Waiting', () => {
        expect(approvalStatusChip('pending').label).toBe('Waiting');
    });
});

describe('productionRouteText: where a test approval would go in production', () => {
    const tp = (_key: string, fallback: string, params?: Record<string, string>) =>
        Object.entries(params || {}).reduce((out, [k, v]) => out.replace(`{${k}}`, v), fallback);

    it('names the stages with their seat counts, never a person', () => {
        const text = productionRouteText({
            isTest: true,
            configuredRouting: {
                runKind: 'test',
                stages: [
                    { key: 'a', name: 'Team lead', approvers: [{ userId: 'u-ada' }] },
                    { key: 'b', name: 'Finance', approvers: [{ groupId: 'g1' }, { userId: 'u2' }] },
                    { key: 'c', name: 'Director', skipped: true, approvers: [{ userId: 'u3' }] },
                ],
            },
        }, tp);
        expect(text).toBe('In production this goes to Team lead (1) → Finance (2) → Director (skipped).');
        expect(text).not.toContain('u-ada');
    });

    it('describes a panel, a single approver, a group and the owner', () => {
        const route = (configuredRouting: object) => productionRouteText({ isTest: true, configuredRouting }, tp);
        expect(route({ approvers: [{ userId: 'a' }, { userId: 'b' }, { groupId: 'g' }] })).toBe('In production this goes to a panel of 3.');
        expect(route({ assignee: { userId: 'a' } })).toBe('In production this goes to one approver.');
        expect(route({ assignee: { groupId: 'g' }, finalApprover: { userId: 'f' } })).toBe('In production this goes to a group then a final sign-off.');
        expect(route({})).toBe("In production this goes to the automation's owner.");
    });

    it('says nothing for a production row', () => {
        expect(productionRouteText({ configuredRouting: { assignee: { userId: 'a' } } }, tp)).toBeNull();
        expect(productionRouteText({ isTest: true }, tp)).toBeNull();
    });
});
