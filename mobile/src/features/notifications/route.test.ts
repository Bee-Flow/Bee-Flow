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
        ['/app/studio/automations/a1?view=runs&run=r9', '/automations/a1/runs', 'core/automationRunner/execution.js'],
        ['/app/studio/automations/a1?view=runs&run=r9&step=s2', '/automations/a1/runs', 'execution.js approval fallback'],
        ['/app/studio/automations/a1', '/automations/a1', 'automation/evolution.js'],
        ['/app/studio/approvals/apr_1', '/approvals/apr_1', 'automation/approvalHooks.js and friends'],
        ['/app/settings/help_support?thread=t1', '/support', 'routes/support/threads.js'],
        ['/app/admin/security/users', '/admin', 'auth/connectorJwt.js'],
        // Both webpage shapes. The first is the one the builder and automation
        // tools hand back as "I made you a page" — it matched no branch at all
        // and fell through to `return null`, i.e. a tap that did nothing and
        // said nothing. The second is the editor address (already frozen on the
        // web side) and used to land on /automations, which is not close
        // enough: a page is not a routine.
        ['/app/webpages/wp1', '/webpages/wp1', 'integrations/webpageBuilderTools.js, webpageAutomationTools.js'],
        ['/app/studio/webpages/wp1', '/webpages/wp1', 'core/webpages/sidePanelWebpageContext.js'],
        // Both used to fall into the /automations catch-all below, even though
        // the phone has had both screens all along: a "this skill is missing
        // something" notification opened the routine list.
        ['/app/studio/skills/sk1', '/skills/sk1', 'projects/completeness.js DEEP_LINK.skill'],
        ['/app/studio/solutions/p1', '/projects/p1', 'routes/studio/attentionChecks.js solutionDeepLink'],
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
    // lists (there is no /recordings index; the Record tab is it).
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
    // on the routine list one section over.
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

    it('keeps the Studio catch-all for the sections the phone has no screen for', () => {
        // The fallback is not dead code: it is what an unknown or desktop-only
        // Studio section still resolves to, and the rows above only carve out
        // the ones with a native twin.
        expect(translateWebLink('/app/studio/datatables/d1')?.href).toBe('/automations');
        expect(translateWebLink('/app/studio')?.href).toBe('/automations');
    });

    it('degrades the one web-only writer with a reason, not a dead tap', () => {
        // jobs/learningNudge.js — the Learning Center has no native screen.
        const target = translateWebLink('/app/settings/learning');
        expect(target?.href).toBeNull();
        expect(target?.unavailableReason).toBeTruthy();
    });

    it('answers null for a link outside the table, so category fallbacks can run', () => {
        expect(translateWebLink('/app/some/screen/added/next/year')).toBeNull();
        expect(translateWebLink(null)).toBeNull();
        expect(translateWebLink(undefined)).toBeNull();
    });

    it('refuses to route an absolute URL to another host', () => {
        const target = translateWebLink('https://elsewhere.example/app/cowork/x');
        expect(target?.href).toBeNull();
    });
});

describe('targetForNotification — the linkless fallbacks stay store-correct', () => {
    const base: AppNotification = {
        id: 'n1', task_id: null, category: 'info', title: '', message: '',
        link: null, read: false, created_at: null,
    };

    it('sends a linkless cowork run to its own detail screen, never /tasks', () => {
        // cowork rows live in cowork_schedules, /tasks reads ai_tasks — the
        // conflation this table exists to prevent.
        expect(targetForNotification({ ...base, category: 'cowork', task_id: 'cw1' }).href).toBe('/cowork/cw1');
    });

    it('sends a linkless ai_task to the tasks list', () => {
        expect(targetForNotification({ ...base, category: 'ai_task', task_id: 't1' }).href).toBe('/tasks');
    });
});
