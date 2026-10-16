/**
 * The drawer's fixed rows, held to the web Sidebar (textual lockstep).
 *
 * agent-hub/src/components/shell/sidebar/sidebarNav.tsx builds two lists,
 * `buildCoreNav` (pinned: New Chat, Cowork, Approvals, Search) and
 * `buildSecondaryNav` (Agents, then the Studio, Apps and Forms rows its
 * helpers return). The drawer renders the same rows in the same order with the
 * same keys and glyphs (model/nav.ts). The file is read as TEXT; each row is
 * the `key: '…'` with the `label: t('…'` and `icon: X` that follow it.
 *
 * When this fails the web sidebar changed: move nav.ts (and the drawer) with
 * it. Don't loosen the test.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CLIENT_DICT, SERVER_DICT, readDict } from '@/core/i18n/dictionaryText';

import { CORE_NAV, SECONDARY_NAV } from './nav';

const WEB = path.resolve(__dirname, '../../../../../agent-hub/src/components/shell/sidebar/sidebarNav.tsx');
const src = fs.readFileSync(WEB, 'utf8');

interface WebRow {
    key: string;
    labelKey: string;
    icon: string;
}

/** The source of one top-level `function <name>(` up to its closing brace. */
function bodyOf(name: string): string {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) return '';
    const end = src.indexOf('\n}\n', start);
    return src.slice(start, end < 0 ? undefined : end);
}

/** The rows written inline in a builder's array literal, in order. */
function inlineRows(body: string): WebRow[] {
    // A row's own key sits at 8 or 12 spaces (spread rows are one level
    // deeper); flyout children are deeper still and are not rows.
    const rows: WebRow[] = [];
    const re = /^ {8,16}(?:\.\.\.\(.*\n\s*\? \[)?\{\s*key: '([^']+)',[\s\S]*?label: t\('([^']+)'[\s\S]*?icon: (\w+)/gm;
    for (const m of body.matchAll(re)) {
        const key = m[1] as string;
        if (key.includes('-all') || key.startsWith('studio-') || key.startsWith('app-') || key.startsWith('form-')) continue;
        rows.push({ key, labelKey: m[2] as string, icon: m[3] as string });
    }
    return rows;
}

/**
 * A builder's rows, in order: the inline ones, then each row a helper builds
 * (`items.push(studioNavItem(…))`), read from the object that helper returns.
 */
function rowsOf(builder: string): WebRow[] {
    const body = bodyOf(builder);
    const rows = inlineRows(body);
    for (const push of body.matchAll(/items\.push\((\w+)\(/g)) {
        const m = /return \{\s*key: '([^']+)',\s*label: (?:\w+\.)?t\('([^']+)'[\s\S]*?icon: (\w+)/.exec(bodyOf(push[1] as string));
        if (m) rows.push({ key: m[1] as string, labelKey: m[2] as string, icon: m[3] as string });
    }
    return rows;
}

const core = rowsOf('buildCoreNav');
const secondary = rowsOf('buildSecondaryNav');

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
