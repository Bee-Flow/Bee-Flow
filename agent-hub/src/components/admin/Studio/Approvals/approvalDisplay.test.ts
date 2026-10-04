import { describe, it, expect } from 'vitest';
import { approvalOriginText, approvalSourceInfo, approvalStatusChip } from './approvalDisplay';

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
