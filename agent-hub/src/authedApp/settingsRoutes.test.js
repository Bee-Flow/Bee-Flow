/**
 * FROZEN_LEGACY (F2) — the /app/settings/* segment space.
 *
 * Sibling of appRoutes.test.js, one level deeper: pageFromPath stops at
 * 'settings', and everything below that second segment is decided here. Two
 * things are pinned, for the same two reasons as in appRoutes.test.js:
 *
 * 1. The shapes that have gone OUT. /app/settings/account/license and
 *    /app/settings/organisation/license are the Stripe checkout return URLs
 *    (BFSF-244), /app/settings/help_support?thread= and /app/settings/learning
 *    are notification links. server/core/appPaths.js mints them and
 *    appPaths.test.js pins the mint side; this file pins the parse side.
 *
 * 2. The G3 collision. 'account' and 'organisation' are group parents, matched
 *    before the top-level lookup. A top-level tab that took one of those names
 *    would be unreachable, and reversing the order to let it win would strand
 *    every payment receipt. The guard below fails the moment someone adds a
 *    tab id that collides — which is the whole reason the tables moved out of
 *    AdvancedSettings.jsx.
 *
 * Renaming a segment is a route move: the new name here, the old one in
 * SETTINGS_LEGACY_SEGMENT_ALIASES, and this freeze updated in the same commit.
 *
 * Third thing pinned, and it is not a freeze but a coupling: the sidebar rows
 * in pages/settings/settingsNavItems.jsx are DERIVED from
 * SETTINGS_TOP_LEVEL_TAB_IDS. G1 (a section in the nav with no address) came
 * from those being two literals, so the tests below read the real nav module
 * rather than a copy of it.
 */

import { describe, it, expect } from 'vitest';
import {
    SETTINGS_TOP_LEVEL_TAB_IDS,
    SETTINGS_GROUP_SEGMENTS,
    SETTINGS_LEGACY_SEGMENT_ALIASES,
    SETTINGS_ACCOUNT_ID_TO_URL,
    SETTINGS_ORG_ID_TO_URL,
    settingsTabFromPath,
    settingsPathForTab,
    settingsOrgDeepSegsFromPath,
} from './settingsRoutes';
import {
    NAV_ITEMS,
    MOBILE_VISIBLE_TOP_TABS,
    SETTINGS_DESKTOP_ONLY_TABS,
    SETTINGS_NAV_ROW_IDS,
} from '../pages/settings/settingsNavItems';

const MOVE_HINT = 'Renaming a settings segment = ONE commit across '
    + 'SETTINGS_TOP_LEVEL_TAB_IDS + SETTINGS_LEGACY_SEGMENT_ALIASES for the old '
    + 'segment + this freeze. See the header of this file and of settingsRoutes.js.';

describe('the top-level tab segments are frozen', () => {
    it('matches the frozen list of segments exactly', () => {
        // The freeze itself: a hand-written table, so a segment cannot change
        // quietly. What it does NOT do is compare anything to the nav — that
        // is the test below, and its absence was G1's actual cause.
        expect(SETTINGS_TOP_LEVEL_TAB_IDS, MOVE_HINT).toEqual([
            'preferences',
            'appearance',
            'security',
            'memory',
            'integrations',
            'learning',
            'help_support',
        ]);
    });

    it('is the list the settings nav is built from — same ids, same order (G1)', () => {
        // The real coupling, read from the nav module instead of retyped. G1
        // was a nav row without an address ('security' rendered, clicked, and
        // changed nothing in the URL); the mirror image is an address with no
        // way in. Deriving NAV_ITEMS from SETTINGS_TOP_LEVEL_TAB_IDS makes both
        // impossible, and this is what proves the derivation is still there —
        // add an eighth row by hand and it goes red instead of shipping G1
        // again.
        expect(NAV_ITEMS.map(item => item.id), MOVE_HINT).toEqual(SETTINGS_TOP_LEVEL_TAB_IDS);
        // Every row is renderable: a derived id with no presentation entry
        // falls back to a placeholder row, which must never reach a user.
        const unlabelled = NAV_ITEMS.filter(item => !item.labelKey || !item.icon).map(item => item.id);
        expect(unlabelled, 'Give the tab a labelKey + icon in pages/settings/settingsNavItems.jsx.').toEqual([]);
        // And the other way round: a presentation row for an id that is not
        // addressable would simply never be built, which is a silent no-op
        // rather than a visible bug — so it fails here.
        expect([...SETTINGS_NAV_ROW_IDS].sort(), 'A nav row needs its segment in '
            + 'SETTINGS_TOP_LEVEL_TAB_IDS, or it renders nowhere.').toEqual([...SETTINGS_TOP_LEVEL_TAB_IDS].sort());
        // Preferences stays first: Simple Mode renders NAV_ITEMS[0] alone, and
        // it is where every bounce (simple mode, self-hosted, phone, unknown
        // segment) lands.
        expect(NAV_ITEMS[0].id).toBe('preferences');
        expect(settingsTabFromPath('/app/settings')).toBe(NAV_ITEMS[0].id);
    });

    it('keeps the phone subset a real subset, subtracted from this list', () => {
        // The comment above MOBILE_VISIBLE_TOP_TABS used to claim 'a strict
        // subset' with nothing enforcing it. It is built by subtraction now;
        // this pins the result, so hiding a section on phones is one edit to
        // SETTINGS_DESKTOP_ONLY_TABS.
        expect(SETTINGS_DESKTOP_ONLY_TABS, MOVE_HINT).toEqual(['integrations', 'learning']);
        expect(MOBILE_VISIBLE_TOP_TABS).toEqual(
            SETTINGS_TOP_LEVEL_TAB_IDS.filter(id => !SETTINGS_DESKTOP_ONLY_TABS.includes(id)),
        );
        expect(MOBILE_VISIBLE_TOP_TABS).toEqual(['preferences', 'appearance', 'security', 'memory', 'help_support']);
        // A phone-visible tab is a deep link a phone may follow: /app/settings
        // is on MOBILE_ALLOWED_PAGES, so each of these must still resolve.
        for (const id of MOBILE_VISIBLE_TOP_TABS) {
            expect(settingsTabFromPath(`/app/settings/${id}`), MOVE_HINT).toBe(id);
        }
    });

    it('round-trips every tab: id → path → id', () => {
        for (const id of SETTINGS_TOP_LEVEL_TAB_IDS) {
            const path = settingsPathForTab(id);
            expect(path, MOVE_HINT).toBe(`/app/settings/${id}`);
            expect(settingsTabFromPath(path), `${path} must stay the address of '${id}'. ${MOVE_HINT}`).toBe(id);
        }
    });

    it('opens Preferences on the bare path and on an unknown segment', () => {
        expect(settingsTabFromPath('/app/settings')).toBe('preferences');
        expect(settingsTabFromPath('/app/settings/')).toBe('preferences');
        expect(settingsTabFromPath('/app/settings/not-a-section-2026')).toBe('preferences');
    });

    it('answers null outside the settings tree, so the caller keeps its own tab', () => {
        expect(settingsTabFromPath('/app')).toBeNull();
        expect(settingsTabFromPath('/app/studio/approvals')).toBeNull();
    });
});

describe('G3: the group parents own their segment', () => {
    it('never lets a top-level tab claim a group segment', () => {
        // The runtime guarantee, stated as a test because the branch order in
        // settingsTabFromPath is what enforces it: 'organisation' and
        // 'account' are matched first, so a tab id equal to either would be
        // dead on arrival. G2 renames the first row's LABEL to 'Account' — the
        // segment stays 'preferences'.
        const collisions = SETTINGS_TOP_LEVEL_TAB_IDS.filter(id => SETTINGS_GROUP_SEGMENTS.includes(id));
        expect(collisions, 'A top-level settings tab may not use a group segment: '
            + '/app/settings/account/* and /app/settings/organisation/* are the '
            + 'consumer and org sub-tab parents, and account/license is a Stripe '
            + 'return URL. Give the tab its own segment instead.').toEqual([]);
    });

    it('keeps /app/settings/account the consumer group, not a tab', () => {
        expect(settingsTabFromPath('/app/settings/account')).toBe('consumer_license');
        expect(settingsTabFromPath('/app/settings/organisation')).toBe('license');
    });
});

describe('FROZEN_LEGACY: settings paths the server has minted', () => {
    it('parses every shape appPaths.js mints back to its own tab', () => {
        // [link as minted, tab id it must open, writer]. The query is stripped
        // the same way the settings reader does it — it routes on the pathname.
        const frozen = [
            ['/app/settings/account/license?checkout=success', 'consumer_license', 'Stripe checkout return (BFSF-244)'],
            ['/app/settings/organisation/license?checkout=cancelled', 'license', 'Stripe checkout return (BFSF-244)'],
            ['/app/settings/help_support?thread=t1', 'help_support', 'routes/support/threads.js'],
            ['/app/settings/learning', 'learning', 'jobs/learningNudge.js'],
        ];
        const wrong = frozen
            .map(([link, tab, writer]) => {
                const got = settingsTabFromPath(link.split('?')[0]);
                return got === tab ? null : `${link} (${writer}): expected '${tab}', got '${got}'`;
            })
            .filter(Boolean);
        expect(wrong, `These links are already in mailboxes and payment receipts. ${MOVE_HINT}`).toEqual([]);
    });

    it('keeps the consumer and organisation sub-segments parsing', () => {
        expect(SETTINGS_ACCOUNT_ID_TO_URL, MOVE_HINT).toEqual({
            consumer_license: 'license',
            consumer_privacy: 'privacy',
            consumer_usage: 'usage',
            consumer_integrations: 'integrations',
            consumer_beta: 'beta',
        });
        expect(SETTINGS_ORG_ID_TO_URL, MOVE_HINT).toEqual({
            license: 'license',
            auth: 'auth',
            privacy: 'privacy',
            encryption: 'encryption',
            info: 'info',
            org_usage: 'usage',
            org_compliance: 'compliance',
            org_users: 'users',
            org_academy: 'academy',
            org_integrations: 'integrations',
            org_mcp: 'mcp',
            org_github_sync: 'github-sync',
            org_nextcloud_sync: 'nextcloud-sync',
            org_meeting_templates: 'meeting-templates',
            org_azure: 'azure',
        });
        for (const [id, url] of Object.entries(SETTINGS_ACCOUNT_ID_TO_URL)) {
            expect(settingsPathForTab(id)).toBe(`/app/settings/account/${url}`);
            expect(settingsTabFromPath(`/app/settings/account/${url}`)).toBe(id);
        }
        for (const [id, url] of Object.entries(SETTINGS_ORG_ID_TO_URL)) {
            expect(settingsPathForTab(id)).toBe(`/app/settings/organisation/${url}`);
            expect(settingsTabFromPath(`/app/settings/organisation/${url}`)).toBe(id);
        }
    });

    it('keeps the renamed segment alive: /app/settings/simple-mode', () => {
        // Simple Mode is a toggle inside Preferences now. The alias is not a
        // retention window — an old bookmark does not expire.
        expect(SETTINGS_LEGACY_SEGMENT_ALIASES, MOVE_HINT).toEqual({ 'simple-mode': 'preferences' });
        expect(settingsTabFromPath('/app/settings/simple-mode')).toBe('preferences');
    });

    it('reads the two deep segments under an organisation sub-tab', () => {
        // ComplianceHub's section + check id, and UsageSection's report.
        expect(settingsOrgDeepSegsFromPath('/app/settings/organisation/compliance/dsr/req%2F1'))
            .toEqual({ seg1: 'dsr', seg2: 'req/1' });
        expect(settingsOrgDeepSegsFromPath('/app/settings/organisation/usage/safety'))
            .toEqual({ seg1: 'safety', seg2: '' });
        expect(settingsOrgDeepSegsFromPath('/app/settings/security')).toEqual({ seg1: '', seg2: '' });
    });
});
