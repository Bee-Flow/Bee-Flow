/**
 * FROZEN_LEGACY (U7) — the native side of the URL contract.
 *
 * The table in route.ts translates every link shape the server mints (the
 * writers are enumerated in its header; the same list is frozen server-side
 * in server/core/appPaths.test.js and web-side in
 * agent-hub/src/authedApp/appRoutes.test.js). This test pins each minted
 * shape to its native outcome so the three sides cannot drift apart: a
 * server that renames a path without updating this table sends every tap of
 * that notification to the wrong screen — or, via pushRoute.ts, silently to
 * the inbox.
 *
 * A red assertion here is not "update the expectation". Moving a route
 * happens in ONE commit across the server helper (appPaths.js), the web
 * aliases (appRoutes.js) and this translation table. U7 freezes; F2 moves.
 */

import { translateWebLink, targetForNotification } from './route';
import type { AppNotification } from './types';

describe('translateWebLink — every server-minted shape, verbatim', () => {
    // [link as the server writes it, expected native href, writer]
    const FROZEN_LEGACY: [string, string | null, string][] = [
        ['/app', '/(tabs)', 'jobs/ncOnboardingReminder.js'],
        ['/app/cowork/task-1', '/cowork/task-1', 'core/aiTaskRunner.js'],
        // The run itself, on the runs screen (app/automations/[id]/runs.tsx reads ?runId=).
        ['/app/studio/automations/a1?view=runs&run=r9', '/automations/a1/runs?runId=r9', 'core/automationRunner/execution.js'],
        ['/app/studio/automations/a1?view=runs&run=r9&step=s2', '/automations/a1/runs?runId=r9', 'execution.js / routes/automation/approvals.js'],
        ['/app/studio/automations/a1', '/automations/a1', 'automation/evolution.js'],
        ['/app/studio/approvals/apr_1', '/approvals/apr_1', 'automation/approvalHooks.js and friends'],
        ['/app/settings/help_support?thread=t1', '/support', 'routes/support/threads.js'],
        // "New user awaiting approval": the members list, on the pending sign-ups.
        ['/app/admin/security/users', '/org/members?status=pending', 'auth/connectorJwt.js'],
        // The Compliance Center: the section, or the one record the notice is about.
        ['/app/admin/compliance/incidents/inc1', '/org/compliance/incidents/inc1', 'utils/appPaths.js complianceIncidentPath'],
        ['/app/admin/compliance/dsr?id=r1', '/org/compliance/dsr/r1', 'jobs/complianceDeadlineNotifier.js (DSR deadline)'],
        ['/app/admin/compliance/dpia', '/org/compliance/dpia', 'jobs/complianceDeadlineNotifier.js'],
        ['/app/admin/compliance/frameworks?tab=calendar', '/org/compliance/frameworks', 'jobs/complianceDeadlineNotifier.js'],
        ['/app/admin/compliance/iso_training', '/org/compliance/training', 'jobs/complianceDeadlineNotifier.js (an old alias)'],
        ['/app/settings/organisation/license?checkout=success', '/org/billing', 'core/appPaths.js (Stripe return)'],
        // Both webpage shapes. The first is the one the builder and automation
        // tools hand back as "I made you a page" — it matched no branch at all
        // and fell through to `return null`, i.e. a tap that did nothing and
        // said nothing. The second is the editor address (already frozen on the
        // web side) and used to land on /automations, which is not close
        // enough: a page is not an automation.
        ['/app/webpages/wp1', '/webpages/wp1', 'integrations/webpageBuilderTools.js, webpageAutomationTools.js'],
        ['/app/studio/webpages/wp1', '/webpages/wp1', 'core/webpages/sidePanelWebpageContext.js'],
        // Both used to fall into the /automations catch-all below, even though
        // the phone has had both screens all along: a "this skill is missing
        // something" notification opened the automation list.
        ['/app/studio/skills/sk1', '/skills/sk1', 'projects/completeness.js DEEP_LINK.skill'],
        ['/app/studio/solutions/p1', '/projects/p1', 'routes/studio/attentionChecks.js solutionDeepLink'],
        // The other completeness deep links: knowledge bases, agents and data
        // tables all have native screens.
        ['/app/studio/knowledge/kb1', '/knowledge/kb1', 'projects/completeness.js DEEP_LINK.kb'],
        ['/app/studio/agents/ag1', '/agents/ag1', 'projects/completeness.js DEEP_LINK.agent'],
        ['/app/studio/datatables/d1', '/datatables/d1', 'projects/completeness.js DEEP_LINK.datatable'],
        ['/app/studio/datatables/d1/retention', '/datatables/d1?tab=retention', "a form's retention settings link"],
        ['/app/agent/ag-1', '/agents/ag-1', 'an agent chat by its whole id'],
        ['/app/agent/ag-1/5b1c2d3e-0f1a-4b2c-8d3e-4f5a6b7c8d9e', '/agents/ag-1?c=5b1c2d3e-0f1a-4b2c-8d3e-4f5a6b7c8d9e', 'an agent conversation'],
        ['/app/d/5b1c2d3e-0f1a-4b2c-8d3e-4f5a6b7c8d9e', '/chat/5b1c2d3e-0f1a-4b2c-8d3e-4f5a6b7c8d9e', 'a direct chat by its whole id'],
        ['/app/studio/datatables/d1/rows', '/datatables/d1?tab=rows', 'a table opened on its rows'],
        ['/app/studio/datatables/d1/dashboard', '/datatables/d1', 'a web-only tab opens the table'],
        ['/app/studio/documents/doc1', '/documents/doc1', 'core/documents/deckDocument.js'],
    ];

    // The web settings sections that have a native screen of their own. Not a
    // server-minted shape yet — /app/settings/security only became a real web
    // address with F2 — but the same contract: a link someone pastes or shares
    // opens the screen it names, instead of the settings index one tap short.
    // The sections the phone does NOT have stay on the index deliberately; see
    // the header of route.ts on why guessing is worse than saying so.
    it.each([
        ['/app/settings/security', '/settings/security'],
        ['/app/settings/appearance', '/settings'],
        ['/app/settings/account/license', '/settings'],
    ])('%s → %s', (link, href) => {
        expect(translateWebLink(link)?.href ?? null).toBe(href);
    });

    it.each(FROZEN_LEGACY)('%s → %s (%s)', (link, href) => {
        expect(translateWebLink(link)?.href ?? null).toBe(href);
    });

    // Not server-minted (yet). `/app/studio/meeting-notes/<id>` is written by
    // nothing in the server tree today — grep finds no writer — so it is not a
    // FROZEN_LEGACY row. It is here because it is the segment the Studio rail
    // navigates to and the section has a native twin, so the day something
    // starts minting it, the link lands instead of falling into the
    // /automations catch-all. The list forms open the screens that ARE the
    // lists (there is no /recordings index; the Meeting Notes tab is it).
    it.each([
        ['/app/studio/meeting-notes/m1', '/recordings/m1'],
        ['/app/studio/meeting-notes', '/(tabs)/record'],
        ['/app/studio/webpages', '/webpages'],
        ['/app/webpages', '/webpages'],
    ])('%s → %s', (link, href) => {
        expect(translateWebLink(link)?.href ?? null).toBe(href);
    });

    // The index forms of the two rows above. Neither is minted by the server
    // today — both writers always carry an id — so they are not FROZEN_LEGACY
    // rows; they are here so a bare section link lands on the list rather than
    // on the automation list one section over.
    it.each([
        ['/app/studio/skills', '/skills'],
        ['/app/studio/solutions', '/projects'],
    ])('%s → %s', (link, href) => {
        expect(translateWebLink(link)?.href ?? null).toBe(href);
    });

    it('sends a solutions link carrying an approval node id to the project list, not to a 404', () => {
        // attentionChecks.js:222 warns that the shared finding kind folds
        // synthetic approval nodes onto 'solution', so this shape can reach a
        // client. The id is NOT an approval id — projects/graph.js:85 mints it
        // as `approval:<ownerType>:<ownerId>:<stepId>` — so it cannot be
        // repaired into /approvals/<id>; the list is the honest destination.
        expect(translateWebLink('/app/studio/solutions/approval:automation:a1:s1')?.href).toBe('/projects');
        // Both writers encode their ids, so the escaped form has to resolve the
        // same way — otherwise the guard is one percent sign wide.
        expect(translateWebLink('/app/studio/solutions/approval%3Aautomation%3Aa1%3As1')?.href).toBe('/projects');
    });

    it('opens Cowork at its older addresses, as the web still does', () => {
        // appRoutes.js pageFromPath: /app/work before the rename, /app/studio/cowork as a Studio tab.
        expect(translateWebLink('/app/work/task-1')).toEqual({ href: '/cowork/task-1' });
        expect(translateWebLink('/app/studio/cowork/task-1')).toEqual({ href: '/cowork/task-1' });
        expect(translateWebLink('/app/studio/cowork')).toEqual({ href: '/cowork' });
    });

    it('opens the Studio hub for Studio itself', () => {
        // The phone has a Studio now: /app/studio and its Start page land on
        // the hub, exactly — it IS the thing the link names.
        expect(translateWebLink('/app/studio')).toEqual({ href: '/studio' });
        expect(translateWebLink('/app/studio/start')).toEqual({ href: '/studio' });
    });

    it('opens the sections that used to be web-only natively, and a create address with its flow open', () => {
        expect(translateWebLink('/app/studio/playbooks/pb1')).toEqual({ href: '/playbooks/pb1' });
        // A run link carries no automation id: the log, not a guess.
        expect(translateWebLink('/app/studio/runs?run=r1')).toEqual({ href: '/runs' });
        expect(translateWebLink('/app/studio/datatables/new')).toEqual({ href: '/datatables?new=1' });
        expect(translateWebLink('/app/studio/playbooks/new')).toEqual({ href: '/playbooks?new=1' });
        expect(translateWebLink('/app/studio/solutions/new')).toEqual({ href: '/projects?create=1' });
        expect(translateWebLink('/app/studio/skills/new')).toEqual({ href: '/skills?new=1' });
        // The phone builds agents: the create flow, as the Agents list's "Create with AI".
        expect(translateWebLink('/app/studio/agents/new')).toEqual({ href: '/agents/new?ai=1' });
        // The web creates apps and meeting notes at …/new too (studioApps.jsx);
        // building apps is not on the phone yet, so that lands on App Studio's coming-soon screen.
        expect(translateWebLink('/app/studio/apps/new')).toEqual({ href: '/studio/apps' });
        expect(translateWebLink('/app/studio/meeting-notes/new')).toEqual({ href: '/(tabs)/record' });
        // A section without a create flow opens its list, not an object called "new".
        expect(translateWebLink('/app/studio/approvals/new')).toEqual({ href: '/approvals' });
    });

    it('lands a segment this build does not know on the hub, and says it is only close', () => {
        // An unknown section — it used to open the automation list.
        expect(translateWebLink('/app/studio/some-new-section/x1')).toEqual({ href: '/studio', approximate: true });
        // The web's short chat addresses cannot be resolved here: the nearest list, never a browser tab.
        expect(translateWebLink('/app/a/5b1c2d3e')).toEqual({ href: '/agents', approximate: true });
        expect(translateWebLink('/app/d/5b1c2d3e')).toEqual({ href: '/chats', approximate: true });
        // The automation list itself is exact.
        expect(translateWebLink('/app/studio/automations')).toEqual({ href: '/automations' });
    });

    it('opens the sections the phone gained screens for', () => {
        // App Studio (the editor) is coming soon; its screen offers to run the app.
        expect(translateWebLink('/app/studio/apps/app1')?.href).toBe('/apps/app1?draft=1');
        expect(translateWebLink('/app/studio/apps')?.href).toBe('/studio/apps');
        expect(translateWebLink('/app/studio/approvals')?.href).toBe('/approvals');
        // A Studio form link carries the AUTOMATION's id, and so does the phone's Form page.
        expect(translateWebLink('/app/studio/forms/auto1')?.href).toBe('/forms/auto1');
        expect(translateWebLink('/app/studio/forms/auto1/answers')?.href).toBe('/forms/auto1');
        // The consumer directories, keyed by their own ids: a form's page token
        // opens it to fill in, on the one route the token may travel in.
        expect(translateWebLink('/app/apps/app1')?.href).toBe('/apps/app1');
        expect(translateWebLink('/app/forms/page1')?.href).toBe('/forms/fill/page1');
    });

    it('accepts the legacy segments and section ids the web still does', () => {
        expect(translateWebLink('/app/studio/automations/a1')?.href).toBe('/automations/a1');
        expect(translateWebLink('/app/studio/ai-tasks/a1?view=runs')?.href).toBe('/automations/a1/runs');
        expect(translateWebLink('/app/studio/meetingNotes/m1')?.href).toBe('/recordings/m1');
    });

    it('degrades the one web-only writer with a reason, not a dead tap', () => {
        // jobs/learningNudge.js — the Learning Center has no native screen,
        // and "on the web" would be wrong: the web hides it at phone width.
        const target = translateWebLink('/app/settings/learning');
        expect(target?.href).toBeNull();
        expect(target?.unavailableReason).toBe('Open the Learning Center in Bee Flow on a computer.');
    });

    it('answers null for a link outside the table, so category fallbacks can run', () => {
        expect(translateWebLink('/app/some/screen/added/next/year')).toBeNull();
        expect(translateWebLink(null)).toBeNull();
        expect(translateWebLink(undefined)).toBeNull();
    });

    it('refuses to route an absolute URL to another host', () => {
        const target = translateWebLink('https://elsewhere.example/app/cowork/x');
        expect(target?.href).toBeNull();
        expect(target?.unavailableReason).toBe('Open this link on a computer.');
    });
});

describe('targetForNotification — the linkless fallbacks stay store-correct', () => {
    const base: AppNotification = {
        id: 'n1', task_id: null, category: 'info', title: '', message: '',
        link: null, read: false, created_at: null,
    };

    it('sends a linkless cowork run to its own detail screen, never /tasks', () => {
        expect(targetForNotification({ ...base, category: 'cowork', task_id: 'cw1' }).href).toBe('/cowork/cw1');
    });

    it('sends an older linkless ai_task to the Cowork item it became', () => {
        expect(targetForNotification({ ...base, category: 'ai_task', task_id: 't1' }).href).toBe('/cowork/t1');
    });
});
