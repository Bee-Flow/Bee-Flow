/**
 * PHONE_WEB_PAGES, held to the web: the pages the web draws on a phone
 * (agent-hub/src/authedApp/appRoutes.js MOBILE_ALLOWED_PAGES, plus the
 * approvals slice of Studio that guards.jsx lets through), and the addresses
 * its pageFromPath maps onto each.
 *
 * Differential: appRoutes.js has no imports, so its own pageFromPath runs
 * beside servedOnPhoneWeb on the same addresses. A page the web adds to its
 * phone list, or an address it moves, fails here until the port follows.
 * So does a Settings section it adds to, or takes off, its desktop-only list
 * (pages/settings/settingsNavItems.jsx): those are PHONE_WEB_HIDDEN here.
 */

import fs from 'node:fs';
import path from 'node:path';

import { PHONE_WEB_HIDDEN, PHONE_WEB_PAGES, servedOnPhoneWeb } from './links';

const WEB = path.resolve(__dirname, '../../../../agent-hub/src/authedApp/appRoutes.js');
/** Where the web decides which Settings sections a phone does not get. JSX, so read as text. */
const SETTINGS_NAV = path.resolve(__dirname, '../../../../agent-hub/src/pages/settings/settingsNavItems.jsx');
const describeIfWeb = fs.existsSync(WEB) ? describe : describe.skip;

interface WebRoutes {
    MOBILE_ALLOWED_PAGES: Set<string>;
    pageFromPath: (pathname: string) => string;
    isApprovalsStudioPath: (pathname: string) => boolean;
}

/** Addresses the web draws on a phone — every entry of the table, spelled out. */
const SERVED = [
    '/app', '/app/a/s1', '/app/agent/a1', '/app/d/c1', '/app/settings', '/app/settings/appearance', '/app/apps', '/app/apps/p1',
    '/app/forms', '/app/forms/tok1', '/app/cowork', '/app/cowork/c1', '/app/work', '/app/work/c1', '/app/studio/cowork',
    '/app/studio/cowork/c1', '/app/studio/approvals', '/app/studio/approvals/ap1',
];

/** Addresses the web sends a phone away from. */
const BOUNCED = [
    '/app/studio', '/app/studio/automations/a1', '/app/studio/webpages/w1', '/app/admin', '/app/admin/security/users',
    '/app/org-settings/users', '/app/billing', '/app/routines/r1', '/app/notebooks/n1', '/app/projects/p1', '/app/webpages/w1',
    '/app/meeting-notes', '/app/templates', '/app/agent-designer/a1',
];

/**
 * Settings sections the web routes to an allowed page ('settings') but whose
 * settings screen hides them on a phone, showing Preferences instead.
 */
const HIDDEN = ['/app/settings/learning', '/app/settings/learning?course=c1', '/app/settings/integrations'];

/** The web's `/app/*` catch-all: it answers `agents`, which draws the chat — not the page the address names. */
const CATCH_ALL = ['/app/some/future/screen', '/app/a', '/app/settingsx', '/app/workbench'];

describeIfWeb('the web pages a phone is shown', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const web = require(WEB) as WebRoutes;
    const webServes = (p: string) => {
        const page = web.pageFromPath(p);
        return web.MOBILE_ALLOWED_PAGES.has(page) || (page === 'studio' && web.isApprovalsStudioPath(p));
    };

    it('are the web’s own allowed pages, each with an address here', () => {
        expect([...new Set(PHONE_WEB_PAGES.map(([page]) => page))].sort()).toEqual([...web.MOBILE_ALLOWED_PAGES].sort());
    });

    it.each(SERVED.map((p) => [p]))('%s is drawn on a phone on both sides', (p) => {
        expect({ web: webServes(p), phone: servedOnPhoneWeb(p) }).toEqual({ web: true, phone: true });
    });

    it.each(BOUNCED.map((p) => [p]))('%s is bounced on both sides', (p) => {
        expect({ web: webServes(p), phone: servedOnPhoneWeb(p) }).toEqual({ web: false, phone: false });
    });

    it.each(HIDDEN.map((p) => [p]))('%s is a Settings section the web hides on a phone', (p) => {
        expect({ web: webServes(p), phone: servedOnPhoneWeb(p) }).toEqual({ web: true, phone: false });
    });

    it('hides exactly the Settings sections the web keeps for a computer', () => {
        const source = fs.readFileSync(SETTINGS_NAV, 'utf8');
        const list = /export const SETTINGS_DESKTOP_ONLY_TABS = \[([^\]]*)\]/.exec(source)?.[1] ?? '';
        const tabs = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
        expect(tabs.length).toBeGreaterThan(0);
        expect([...PHONE_WEB_HIDDEN].sort()).toEqual(tabs.map((tab) => `/app/settings/${tab}`).sort());
    });

    it.each(CATCH_ALL.map((p) => [p]))('%s lands in the web’s catch-all chat, which is not the page', (p) => {
        expect({ page: web.pageFromPath(p), phone: servedOnPhoneWeb(p) }).toEqual({ page: 'agents', phone: false });
    });

    it('lists every table address among the ones checked', () => {
        const checked = [...SERVED];
        for (const [, at] of PHONE_WEB_PAGES) {
            expect({ at, checked: checked.some((p) => (at.endsWith('/') ? p.startsWith(at) : p === at)) }).toEqual({ at, checked: true });
        }
    });
});
