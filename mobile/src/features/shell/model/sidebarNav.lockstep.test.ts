/**
 * The drawer's fixed rows, held to the web Sidebar.
 *
 * agent-hub/src/components/shell/sidebar/sidebarNav.tsx builds two lists,
 * `buildCoreNav` (pinned: New Chat, Cowork, Approvals, Search; Documents on a
 * computer only) and `buildSecondaryNav` (Agents, then the Studio, Apps and
 * Forms rows its helpers return). The drawer renders the same rows in the same
 * order with the same keys and glyphs (model/nav.ts). The web's rows are read
 * from its GUI inventory golden (sidebarNav.inventory.golden.json, recorded from
 * the running builders by sidebarNav.inventory.test.ts beside it): each row's
 * key, i18n label key, icon (as the web file imports it) and the options that
 * gate it. A row gated on `!isMobile` is one the web draws on a computer only,
 * so the drawer of a phone leaves it out.
 *
 * When this fails the web sidebar changed: move nav.ts (and the drawer) with
 * it. Don't loosen the test.
 */

import { CLIENT_DICT, SERVER_DICT, readDict } from '@/core/i18n/dictionaryText';
import { webGolden } from '@/shared/testing/webModule';

import { CORE_NAV, SECONDARY_NAV } from './nav';

interface WebRow {
    key: string;
    labelKey: string;
    icon: string;
}

interface GoldenRow extends WebRow {
    gate: string[];
}

interface SidebarGolden {
    core: GoldenRow[];
    secondary: GoldenRow[];
}

const golden = webGolden<SidebarGolden>('components/shell/sidebar/sidebarNav.inventory.golden.json');

/** A builder's rows a phone gets, in order. */
const rowsOf = (rows: GoldenRow[]): WebRow[] =>
    rows.filter((r) => !r.gate.includes('!isMobile')).map(({ key, labelKey, icon }) => ({ key, labelKey, icon }));

const core = rowsOf(golden.core);
const secondary = rowsOf(golden.secondary);

describe('the web sidebar is readable at all', () => {
    it('found both arrays', () => {
        expect(core.length).toBe(4);
        expect(secondary.length).toBe(4);
    });
});

describe('the drawer against the web sidebar', () => {
    it('pins the same core rows, in order, with the same keys and glyphs', () => {
        expect(CORE_NAV.map(({ key, labelKey, icon }) => ({ key, labelKey, icon }))).toEqual(core);
    });

    it('lists the same secondary rows, in order, with the same keys and glyphs', () => {
        expect(SECONDARY_NAV.map(({ key, labelKey, icon }) => ({ key, labelKey, icon }))).toEqual(secondary);
    });
});

describe('the labels the drawer borrows', () => {
    const client = readDict(CLIENT_DICT);
    const server = readDict(SERVER_DICT);

    it.each([...CORE_NAV, ...SECONDARY_NAV].map((row) => [row.labelKey, row.labelFallback]))(
        '%s is in both dictionaries, and its English is the fallback',
        (key, fallback) => {
            expect({ client: client.has(key), server: server.has(key) }).toEqual({ client: true, server: true });
            expect(server.get(key)).toBe(fallback);
        },
    );
});
