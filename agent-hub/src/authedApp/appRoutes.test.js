/**
 * FROZEN_LEGACY (U7) — the client side of the URL contract.
 *
 * Two different freezes live here, and they fail for different reasons:
 *
 * 1. PAGE_ROUTES — the canonical route table. Renaming or moving a route
 *    makes the frozen table below go red. That red is not "update the
 *    expectation": a route moves in ONE commit that also (a) keeps the OLD
 *    path parsing as an alias in pageFromPath, (b) updates
 *    MOBILE_ALLOWED_PAGES + mobilePageKey + the guards, and (c) keeps every
 *    server-minted shape translating in mobile route.ts. F2 is the track that
 *    moves routes; U7 only freezes them.
 *
 * 2. FROZEN_LEGACY — every path that ever went OUT of the system: written
 *    into a notifications.link row, an email, a Nextcloud Talk card or a
 *    YouTrack reference (minted server-side by core/appPaths.js, which has
 *    the same table in its own test), plus the legacy aliases old bookmarks
 *    still use. These rows have no retention window — the comment claiming
 *    old paths parse "for one release" is gone from appRoutes.js, because a
 *    link in someone's mailbox does not expire after a release. None of these
 *    branches is ever dead code; deleting one strands real links.
 *
 * Sibling freezes: server/core/appPaths.test.js (the mint side),
 * mobile/src/features/notifications/{route,pushRoute}.test.ts (the native
 * translation), studioRoutes.test.js (Studio sub-segments),
 * settingsRoutes.test.js (everything below /app/settings, where pageFromPath
 * stops).
 */

import { describe, it, expect } from 'vitest';
import {
    PAGE_ROUTES,
    MOBILE_ALLOWED_PAGES,
    mobilePageKey,
    pageFromPath,
    isApprovalsPageArg,
    isApprovalsStudioPath,
    parseCoworkUrl,
    parseDocumentUrl,
    documentRoutePath,
    parseAgentUrl,
    parseDirectChatUrl,
    parseAdminPath,
    usesStudioRail,
    usesProjectRail,
} from './appRoutes';
import { parseStudioUrl } from '../components/admin/Studio/studioRoutes';

const MOVE_HINT = 'Moving a route = ONE commit across PAGE_ROUTES + a pageFromPath alias '
    + 'for the old path + MOBILE_ALLOWED_PAGES/guards + mobile route.ts + this freeze. '
    + 'U7 freezes; F2 moves. See the header of this file.';

describe('PAGE_ROUTES is frozen', () => {
    it('matches the frozen canonical table exactly', () => {
        expect(PAGE_ROUTES, MOVE_HINT).toEqual({
            agents: '/app',
            admin: '/app/admin',
            orgSettings: '/app/org-settings',
            settings: '/app/settings',
            billing: '/app/billing',
            agentDesigner: '/app/agent-designer',
            agentDesignerAdvanced: '/app/agent-designer-advanced',
            agentWizard: '/app/agent-wizard',
            studio: '/app/studio',
            cowork: '/app/cowork',
            apps: '/app/apps',
            forms: '/app/forms',
            documents: '/app/documents',
            reports: '/app/reports',
            components: '/app/components',
            meetingNotes: '/app/meeting-notes',
            templates: '/app/templates',
            notebooks: '/app/notebooks',
            projects: '/app/projects',
            webpages: '/app/webpages',
        });
    });

    it('routes every canonical path back to its own page key', () => {
        // The exact-match branch of pageFromPath wins before any alias rule,
        // so even meetingNotes/webpages (whose SUB-paths land on studio)
        // keep their own key on the bare path.
        for (const [page, path] of Object.entries(PAGE_ROUTES)) {
            expect(pageFromPath(path), `${path} must stay the address of '${page}'. ${MOVE_HINT}`).toBe(page);
        }
    });

    it('keeps Studio sections OUT of the page table (B9)', () => {
        // Runs & logboek lands at /app/studio/runs as a Studio SECTION — an
        // entry in the Studio app registry (studioApps.jsx → studioRoutes.js),
        // which is where every other section already comes from. It gets no
        // page key: a second key for a screen that already has an address is a
        // second URL surface, and the two drift.
        expect(Object.keys(PAGE_ROUTES), MOVE_HINT).not.toContain('runs');
        expect(pageFromPath('/app/studio/runs')).toBe('studio');
        expect(pageFromPath('/app/studio/runs/r9')).toBe('studio');
        // The same is already true of every shipped section, which is the
        // evidence that a section needs nothing here.
        expect(pageFromPath('/app/studio/automations')).toBe('studio');
        expect(pageFromPath('/app/studio/approvals')).toBe('studio');
    });

    it('keeps the bare /app/studio page key even though its SECTION moved (H1)', () => {
        // H1 changed which section /app/studio opens — 'agents' → 'start'
        // (studioRoutes.test.js). That change lives entirely inside Studio's
        // section resolution: the PAGE key must not move with it, because
        // that is what the frozen table, the mobile allow-list and every
        // guard read. If this row ever goes red, a section change leaked into
        // the route contract.
        expect(pageFromPath('/app/studio'), MOVE_HINT).toBe('studio');
        expect(pageFromPath('/app/studio/start'), MOVE_HINT).toBe('studio');
        expect(PAGE_ROUTES.studio).toBe('/app/studio');
        expect(Object.keys(PAGE_ROUTES), MOVE_HINT).not.toContain('start');
    });
});

describe('member documents routing', () => {
    it('keeps member links in the ordinary workspace and Studio links in Studio', () => {
        expect(pageFromPath('/app/documents/d1')).toBe('documents');
        expect(pageFromPath('/app/documents/notebook/n1')).toBe('documents');
        expect(usesStudioRail('documents')).toBe(false);
        expect(pageFromPath('/app/studio/documents/d1')).toBe('studio');
        expect(pageFromPath('/app/notebooks/n1')).toBe('studio');
    });

    it('round-trips document and notebook references, including URL escaping', () => {
        expect(documentRoutePath()).toBe('/app/documents');
        expect(parseDocumentUrl('/app/documents')).toBeNull();
        for (const ref of ['d1', 'notebook/n1', 'notebook/name with spaces', 'doc#1']) {
            expect(parseDocumentUrl(documentRoutePath(ref))).toBe(ref);
        }
        expect(parseDocumentUrl('/app/documents/%invalid')).toBeNull();
        expect(parseDocumentUrl('/app/studio/documents/d1')).toBeNull();
    });
});

describe('usesProjectRail — the project rail flag', () => {
    it('is true on the projects page with a project open', () => {
        expect(usesProjectRail('projects', '1a4834b9')).toBe(true);
    });
    it('is false on the list, the create form and other pages', () => {
        expect(usesProjectRail('projects', null)).toBe(false);
        expect(usesProjectRail('projects', undefined)).toBe(false);
        expect(usesProjectRail('projects', '')).toBe(false);
        expect(usesProjectRail('projects', 'new')).toBe(false);
        expect(usesProjectRail('agents', 'x')).toBe(false);
        expect(usesProjectRail('projects/1a4834b9', '1a4834b9')).toBe(false);
    });
});

describe('usesStudioRail — the rail flag (H1)', () => {
    it('is true for Studio and nothing else', () => {
        // A FLAG, not a route: it answers a chrome question about a page key
        // that already exists. Every other page keeps the global sidebar, so
        // a page key that starts answering true here is a redesign, not a
        // rename.
        expect(usesStudioRail('studio')).toBe(true);
        expect(usesStudioRail('studio', 'agents')).toBe(true);
        const others = Object.keys(PAGE_ROUTES).filter((p) => p !== 'studio');
        expect(others.filter((p) => usesStudioRail(p))).toEqual([]);
        // Non-page arguments must not trip it either — Sidebar asks with
        // whatever currentPage holds, including these.
        for (const junk of [null, undefined, '', 'appRun', 'formView', 'approvals', 'studio/agents']) {
            expect(usesStudioRail(junk), `usesStudioRail(${JSON.stringify(junk)})`).toBe(false);
        }
    });

    it('leaves the Approvals slice on the ordinary sidebar', () => {
        // /app/studio/approvals is a Studio address the whole org reaches from
        // a notification, and the section is hiddenFromNav — so the rail would
        // not even list it. Its page key stays 'studio' (that is frozen); only
        // the chrome differs.
        expect(pageFromPath('/app/studio/approvals/apr_1')).toBe('studio');
        expect(usesStudioRail('studio', 'approvals')).toBe(false);
    });
});

// One row per shape with its writer — the same list that
// server/core/appPaths.js mints and mobile route.ts translates. The SPA
// routes on location.pathname, so the query is stripped before parsing.
const FROZEN_LEGACY = [
    // [link as minted, page key it must land on, writer]
    ['/app', 'agents', 'jobs/ncOnboardingReminder.js, welcome email'],
    ['/app?support=th1', 'agents', 'routes/support/shared.js requester thread URL'],
    ['/app/cowork/task-1', 'cowork', 'core/aiTaskRunner.js run notification'],
    ['/app/studio/automations/a1', 'studio', 'automation/evolution.js'],
    ['/app/studio/automations/a1?view=runs&run=r9', 'studio', 'core/automationRunner/execution.js'],
    ['/app/studio/automations/a1?view=runs&run=r9&step=s2', 'studio', 'execution.js + routes/automation/approvals.js'],
    ['/app/studio/approvals/apr_1', 'studio', 'approvalNotify/-Hooks/-Lifecycle + Nextcloud cards'],
    ['/app/settings/help_support?thread=t1', 'settings', 'routes/support/threads.js'],
    ['/app/settings/learning', 'settings', 'jobs/learningNudge.js'],
    ['/app/settings/account/license?checkout=success', 'settings', 'Stripe checkout return (BFSF-244)'],
    ['/app/settings/organisation/license?checkout=cancelled', 'settings', 'Stripe checkout return (BFSF-244)'],
    ['/app/settings?tab=license', 'settings', 'Stripe portal return'],
    ['/app/admin/security/users', 'admin', 'auth/connectorJwt.js pending-user bell'],
    ['/app/admin/support/th1', 'admin', 'issueEgress (BFSF-441 ticket ref), supportIssueSync'],
    ['/app/admin?tab=support&thread=t1', 'admin', 'routes/support/shared.js staff email'],
    ['/app/admin/subscriptions', 'admin', 'Stripe admin email'],
    ['/app/admin/compliance/incidents/i1', 'admin', 'complianceDeadlineNotifier, breach events, Art. 33 ack email'],
    ['/app/admin/compliance/dsr', 'admin', 'complianceDeadlineNotifier, compliance/events'],
    ['/app/admin/compliance/ropa', 'admin', 'compliance/events'],
    ['/app/admin/compliance/dpia', 'admin', 'complianceDeadlineNotifier'],
    ['/app/admin/compliance/iso_controls', 'admin', 'compliance/events'],
    ['/app/admin/compliance/iso_training', 'admin', 'complianceDeadlineNotifier'],
    ['/app/webpages/wp1', 'studio', 'webpage builder/automation tool results'],
    ['/app/studio/webpages/wp1', 'studio', 'side-panel AI context editor URL'],
];

describe('FROZEN_LEGACY: paths the server has minted into mailboxes and tickets', () => {
    it('lands every minted link on the page it was written for', () => {
        const wrong = FROZEN_LEGACY
            .map(([link, page, writer]) => {
                const got = pageFromPath(link.split('?')[0]);
                return got === page ? null : `${link} (${writer}): expected '${page}', got '${got}'`;
            })
            .filter(Boolean);
        expect(wrong, `These links are already in mailboxes/tickets and may never break. ${MOVE_HINT}`).toEqual([]);
    });

    it('keeps parsing every legacy alias — notifications.link rows, not a retention window', () => {
        // Verbatim truth table of the alias branches in pageFromPath. Each of
        // these shapes exists in old bookmarks, emails or notification rows;
        // the branch that parses it is never dead code.
        const aliases = [
            ['/', 'agents'],
            ['/app/ai-tasks', 'studio'], // the old standalone automations page, under three names
            ['/app/ai-tasks/t1', 'studio'],
            ['/app/routines/t1', 'studio'],
            ['/app/automations/t1', 'studio'],
            ['/app/work', 'cowork'], // Cowork's previous name
            ['/app/work/w1', 'cowork'],
            ['/app/studio/cowork', 'cowork'], // Cowork's previous life as a Studio tab
            ['/app/studio/cowork/c1', 'cowork'],
            ['/app/meeting-notes/m1', 'studio'], // renders inside Studio now
            ['/app/webpages/w1', 'studio'],
            ['/admin', 'admin'], // bare pre-/app forms
            ['/admin/users', 'admin'],
            ['/org-settings', 'orgSettings'],
            ['/a/sh0rt', 'agents'],
            ['/agent/full-id', 'agents'],
            ['/d/c0nv', 'agents'],
            ['/app/a/sh0rt', 'agents'],
            ['/app/agent/full-id', 'agents'],
            ['/app/d/c0nv', 'agents'],
            ['/app/apps', 'apps'],
            ['/app/apps/app-1', 'appRun'],
            ['/app/forms', 'forms'],
            ['/app/forms/tok3n', 'formView'],
            ['/app/notebooks/n1', 'studio'], // a notebook opens in Studio → Documents now
            ['/app/projects/p1', 'projects'],
            ['/app/projects/p1/chats/c1', 'projects'],
            ['/app/projects/new', 'projects'],
        ];
        const wrong = aliases
            .map(([path, page]) => {
                const got = pageFromPath(path);
                return got === page ? null : `${path}: expected '${page}', got '${got}'`;
            })
            .filter(Boolean);
        expect(wrong, `A legacy alias stopped parsing. ${MOVE_HINT}`).toEqual([]);
    });

    it('keeps the deep-link ids of the renamed pages parseable', () => {
        // The alias landing on the right PAGE is not enough — the id must
        // survive too, or the page opens empty.
        // The old standalone automations page opens Studio → Automations, on the same automation.
        for (const path of ['/app/ai-tasks/t1', '/app/routines/t1', '/app/automations/t1']) {
            expect(parseStudioUrl(path)).toMatchObject({ section: 'aiTasks', id: 't1' });
        }
        expect(parseCoworkUrl('/app/studio/cowork/c1')).toBe('c1');
        expect(parseCoworkUrl('/app/work/w1')).toBe('w1');
        expect(parseCoworkUrl('/app/cowork/c1')).toBe('c1');
        expect(parseAgentUrl('/a/ag1/cv2')).toEqual({ agentId: 'ag1', conversationId: 'cv2' });
        expect(parseDirectChatUrl('/d/cv3')).toBe('cv3');
    });

    it('documents the two known-stale server shapes: they fall back to home, not 404', () => {
        // Neither /login nor /settings/billing is a real route. /login is a
        // DECLARED redirect alias now rather than a fall-through landing (B1:
        // login renders in place, so there will be no /login route). Its query
        // string is what the boot code reads, and three files mint one:
        // emailVerificationRoutes (?verified=1, ?error=verify_*), inviteRoutes
        // (?signup=1, ?error=invite_*) and passwordResetRoutes (?reset=<token>)
        // — all through core/appPaths.legacyLoginPath, pinned in
        // appPaths.test.js. The invite MAIL is not among them: it carries
        // /auth/redeem-invite/<token> to keep the token out of the URL bar and
        // the proxy logs. /settings/billing still rides the fall-through;
        // giving it a real page is a deliberate change on BOTH sides, and until
        // then this fallback keeps the mail clickable.
        expect(pageFromPath('/settings/billing')).toBe('agents');
        expect(pageFromPath('/login')).toBe('agents');
        expect(pageFromPath('/login/')).toBe('agents');
        expect(pageFromPath('/app/definitely-not-a-page-2026')).toBe('agents');
    });

    it('answers /login before the legacy ?page= branch — the one behaviour change', () => {
        // Declaring the alias moved /login ahead of the ?page= lookup it used
        // to reach (it never hit the /app/* fall-through: it does not start
        // with /app/). So /login?page=<key> opens agents now instead of that
        // page. Nothing mints that shape — the mails carry ?verified= /
        // ?signup= / ?reset= / ?error= — but the change is real, so it is
        // written down rather than left as a surprise. The branch itself stays
        // alive for every other path.
        const restore = window.location.pathname + window.location.search;
        try {
            window.history.replaceState({}, '', '/login?page=studio');
            expect(pageFromPath('/login')).toBe('agents');
            expect(pageFromPath('/somewhere-else')).toBe('studio');
        } finally {
            window.history.replaceState({}, '', restore);
        }
    });
});

describe('mobile allow-list is frozen', () => {
    it('matches the frozen set exactly', () => {
        expect([...MOBILE_ALLOWED_PAGES].sort(), MOVE_HINT).toEqual(
            ['agents', 'approvals', 'appRun', 'apps', 'cowork', 'formView', 'forms', 'projects', 'settings'].sort(),
        );
    });

    it('keeps the approvals slice phone-reachable — the notification tap depends on it', () => {
        // /app/studio/approvals/:id is what approval bells/pushes carry; the
        // phone admits ONLY that slice of Studio.
        expect(mobilePageKey('studio/approvals/apr_1')).toBe('approvals');
        expect(mobilePageKey('studio/approvals')).toBe('approvals');
        expect(mobilePageKey('studio/agents')).toBe('studio');
        expect(MOBILE_ALLOWED_PAGES.has('approvals')).toBe(true);
        expect(MOBILE_ALLOWED_PAGES.has('studio')).toBe(false);
    });

    it('allows responsive projects pages on phones, including item routes', () => {
        // navigateToPage speaks project pages as 'projects/<id>/<tab>/<sub>';
        // the workspace now has a labelled mobile section selector.
        expect(mobilePageKey('projects')).toBe('projects');
        expect(mobilePageKey('projects/p1/chats/c1')).toBe('projects');
        expect(MOBILE_ALLOWED_PAGES.has('projects')).toBe(true);
    });

    it('reads the approvals slice from ONE predicate, in both of its shapes', () => {
        // B2 leaves the approvals URL where it is; what moved is the chrome.
        // The slice is spoken as a navigateToPage argument and as a pathname,
        // and MobileRouteGuard used to carry its own second regex for the
        // pathname form. pageFromPath answers 'studio' for this path, so that
        // predicate is the ONLY thing keeping an approval push off the bounce
        // to /app — two copies of it was one copy too many.
        expect(isApprovalsPageArg('studio/approvals')).toBe(true);
        expect(isApprovalsPageArg('studio/approvals/apr_1')).toBe(true);
        expect(isApprovalsPageArg('studio/agents')).toBe(false);
        expect(isApprovalsStudioPath('/app/studio/approvals')).toBe(true);
        expect(isApprovalsStudioPath('/app/studio/approvals/apr_1')).toBe(true);
        expect(isApprovalsStudioPath('/app/studio/agents')).toBe(false);
        // Near-misses that must not open the phone's one Studio door.
        expect(isApprovalsStudioPath('/app/studio/approvalsomething')).toBe(false);
        expect(isApprovalsStudioPath('/studio/approvals')).toBe(false);
        expect(isApprovalsStudioPath(null)).toBe(false);
        // The guard's question and the allow-list's question, on one path.
        expect(mobilePageKey('studio/approvals/apr_1')).toBe(
            isApprovalsStudioPath('/app/studio/approvals/apr_1') ? 'approvals' : 'studio',
        );
    });
});

describe('parseAdminPath — the query is never a segment', () => {
    it('reads the segments of an admin path with or without a query', () => {
        expect(parseAdminPath('/app/admin/compliance/incidents/i1')).toEqual({ seg1: 'compliance', seg2: 'incidents', seg3: 'i1' });
        // In-app navigation hands over the page string with the hub's header tab.
        expect(parseAdminPath('/app/admin/compliance/frameworks?tab=calendar')).toEqual({ seg1: 'compliance', seg2: 'frameworks', seg3: '' });
        expect(parseAdminPath('/app/admin/compliance/gdpr/GDPR-Art30?tab=checks#x')).toEqual({ seg1: 'compliance', seg2: 'gdpr', seg3: 'GDPR-Art30' });
        expect(parseAdminPath('/app/admin?tab=support')).toEqual({ seg1: '', seg2: '', seg3: '' });
        expect(parseAdminPath('/app/agents')).toEqual({ seg1: '', seg2: '', seg3: '' });
    });
});
