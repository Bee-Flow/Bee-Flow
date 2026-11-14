import { describe, expect, it } from 'vitest';
import { resolveNavigationTarget, type NavigationContextInfo } from './navigationTargets';

const desktop: NavigationContextInfo = { isMobile: false, isConsumerAccount: false, currentPathname: '/app' };
const resolve = (page: string, ctx: Partial<NavigationContextInfo> = {}, replace = false) => resolveNavigationTarget(page, { replace }, { ...desktop, ...ctx });

describe('resolveNavigationTarget: one address per page name', () => {
    it.each([
        ['home', '/app'],
        ['agents', '/app'],
        ['settings/memory', '/app/settings/memory'],
        ['admin/compliance/frameworks?tab=calendar', '/app/admin/compliance/frameworks?tab=calendar'],
        ['org-settings/agents', '/app/org-settings/agents'],
        ['studio', '/app/studio/agents'],
        ['studio:agents:ag1', '/app/studio/agents/ag1'],
        ['studio/automations/t1?view=runs&run=r9', '/app/studio/automations/t1?view=runs&run=r9'],
        ['studio/automations/steps/s1/f1', '/app/studio/automations/steps/s1/f1'],
        ['studio/knowledge/kb1/sources/src1', '/app/studio/knowledge/kb1/sources/src1'],
        ['aiTasks:t1', '/app/studio/automations/t1'],
        ['notebooks/n1', '/app/studio/documents/notebook/n1'],
        ['webpages/w1', '/app/studio/webpages/w1'],
        ['agentDesigner', '/app/studio/agents'],
        ['agentDesigner:ag1', '/app/agent-designer/ag1'],
        ['agentWizard', '/app/agent-wizard'],
        ['apps/a1', '/app/apps/a1'],
        ['forms/tok1', '/app/forms/tok1'],
        ['projects/p1/chats/c1', '/app/projects/p1/chats/c1'],
        ['documents/notebook/n1', '/app/documents/notebook/n1'],
        ['/app/d/c1', '/app/d/c1'],
        ['no-such-page', '/'],
    ])('%s → %s', (page, path) => {
        expect(resolve(page).path).toBe(path);
    });

    it('stamps the run a Studio address opens into the history state, for the runs panel', () => {
        expect(resolve('studio/automations/t1?view=runs&run=r9').state).toEqual({ page: 'studio', beeflowRunOpen: 'r9' });
        expect(resolve('studio/automations/t1').state).toEqual({ page: 'studio', beeflowRunOpen: null });
    });

    it('resolves billing to the plan page of the account', () => {
        expect(resolve('billing').path).toBe('/app/admin/organisation/license');
        expect(resolve('billing', { isConsumerAccount: true }).path).toBe('/app/settings/account/license');
        expect(resolve('billing', { isMobile: true }).path).toBe('/app/settings/organisation/license');
    });

    it('pushes a Cowork item from another page and replaces it inside Cowork', () => {
        expect(resolve('cowork/cw1')).toMatchObject({ path: '/app/cowork/cw1', replace: false });
        expect(resolve('cowork/cw1', { currentPathname: '/app/cowork' })).toMatchObject({ replace: true });
        expect(resolve('cowork/cw1', { currentPathname: '/app/cowork/cw0' })).toMatchObject({ replace: true });
        expect(resolve('cowork', { currentPathname: '/app/cowork/cw0' })).toMatchObject({ path: '/app/cowork', replace: false });
    });

    it('on a phone, sends a desktop-only page home and lets the allow-list through', () => {
        expect(resolve('admin', { isMobile: true }).path).toBe('/app');
        expect(resolve('/app/studio/agents', { isMobile: true }).path).toBe('/app');
        expect(resolve('studio/approvals/apr1', { isMobile: true }).path).toBe('/app/studio/approvals/apr1');
        expect(resolve('/app/studio/approvals/apr1', { isMobile: true }).path).toBe('/app/studio/approvals/apr1');
        expect(resolve('cowork/cw1', { isMobile: true }).path).toBe('/app/cowork/cw1');
    });

    it('honours replace for every page name', () => {
        for (const page of ['settings', 'admin', 'studio/agents', 'documents/d1', 'projects/p1', 'apps/a1', 'templates']) {
            expect(resolve(page, {}, true).replace, page).toBe(true);
        }
    });
});
