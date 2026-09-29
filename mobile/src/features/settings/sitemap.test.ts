/**
 * The More tab is the app's claim that every Bee Flow feature is reachable
 * from a phone. This is the test that makes the claim checkable.
 *
 * A screen that exists but is linked from nowhere is worse than a screen that
 * does not exist: it costs the same to build and maintain, and no user will
 * ever find it. That is not hypothetical here — five surfaces (skills, memory,
 * webpages, forms, MCP) shipped with no entry point at all, because they were
 * written by agents that were deliberately forbidden from editing this file.
 * A one-off audit found them; this stops the next five.
 *
 * It works off the real app/ directory rather than a hand-kept list, so a new
 * screen fails the test until somebody decides where it belongs in the map.
 */

import fs from 'node:fs';
import path from 'node:path';

import { DESTINATIONS, GROUP_ORDER, matchesSearch, type Destination } from './sitemap';

const APP_DIR = path.resolve(__dirname, '../../../app');

/**
 * Routes that are legitimately absent from the map.
 *
 * The signed-out flow is not a set of destinations — you do not navigate to
 * "MFA", the auth state machine takes you there — and `/more` is the map
 * itself. Everything else must be listed, and adding to this set should feel
 * uncomfortable.
 */
const NOT_DESTINATIONS = new Set([
    '/',
    '/more',
    // The complete map itself. Listing it as a destination on the map would be
    // circular, and it is reachable from the bottom of More by design.
    '/sitemap',
    '/server',
    '/login',
    '/mfa',
    '/mfa-setup',
    '/verify-email',
    '/encryption-setup',
    '/encryption-pin',
    '/pending-approval',
    '/locked',
    // Same reason as the rest of this list: the auth state machine puts you
    // there when the server cannot be reached. You cannot navigate to "no
    // network", and a map entry for it would be a dead tap.
    '/unreachable',
]);

/** Tab roots are listed in the map under their group path, e.g. /(tabs)/record. */
const TAB_ROUTES: Record<string, string> = {
    '/record': '/(tabs)/record',
    '/library': '/(tabs)/library',
    '/cowork': '/(tabs)/cowork',
};

/** Top-level screens: `app/foo.tsx` and `app/foo/index.tsx`, minus [param] routes. */
function topLevelRoutes(): string[] {
    const found: string[] = [];
    const walk = (dir: string, prefix: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const isGroup = entry.name.startsWith('(') && entry.name.endsWith(')');
            if (entry.isDirectory()) {
                walk(path.join(dir, entry.name), isGroup ? prefix : `${prefix}/${entry.name}`);
            } else if (
                entry.name.endsWith('.tsx') &&
                !entry.name.startsWith('_') &&
                // expo-router hooks (+not-found, +native-intent) are not
                // destinations — see isScreenFile in src/lib/routes.test.ts.
                !entry.name.startsWith('+') &&
                !entry.name.includes('.test.')
            ) {
                const base = entry.name.replace(/\.tsx$/, '');
                const route = base === 'index' ? prefix || '/' : `${prefix}/${base}`;
                // A [param] route is a detail screen reached from a list, and a
                // nested one (settings/account) is reached from its parent —
                // neither is a top-level destination.
                if (route.includes('[')) continue;
                found.push(route);
            }
        }
    };
    walk(APP_DIR, '');
    // Keep one level deep, plus the settings/ and org/ children the map does
    // list individually.
    return [...new Set(found)].filter((route) => {
        const depth = route.split('/').filter(Boolean).length;
        if (depth <= 1) return true;
        return route.startsWith('/settings/') || route.startsWith('/org/');
    });
}

const linked = new Set(DESTINATIONS.map((d) => d.href));

describe('the More tab is a complete map', () => {
    it('found the app directory', () => {
        expect(topLevelRoutes().length).toBeGreaterThan(20);
    });

    it('links every screen a user is meant to navigate to', () => {
        const unreachable = topLevelRoutes()
            .filter((route) => !NOT_DESTINATIONS.has(route))
            .map((route) => TAB_ROUTES[route] ?? route)
            .filter((route) => !linked.has(route));
        // Named, not counted: the useful failure says which screen nobody can
        // reach.
        expect(unreachable).toEqual([]);
    });

    it('has no destination pointing at a screen that does not exist', () => {
        const routes = new Set([
            ...topLevelRoutes(),
            ...Object.values(TAB_ROUTES),
            '/(tabs)',
        ]);
        const dangling = DESTINATIONS.filter((d) => !d.external && !routes.has(d.href)).map(
            (d) => `${d.id} -> ${d.href}`,
        );
        expect(dangling).toEqual([]);
    });
});

describe('destination hygiene', () => {
    const ids = DESTINATIONS.map((d) => d.id);

    it('has unique ids, which are also the list keys', () => {
        expect(ids).toHaveLength(new Set(ids).size);
    });

    it('puts every destination in a group the screen renders', () => {
        for (const d of DESTINATIONS) expect(GROUP_ORDER).toContain(d.group);
    });

    it('gives every destination a hint, because the label alone is not enough', () => {
        // "Memory" and "Skills" mean nothing to someone who has not used the
        // web app; the hint is what makes this screen navigable by a newcomer.
        for (const d of DESTINATIONS) {
            expect(d.hint.length).toBeGreaterThan(10);
            expect(d.label.length).toBeGreaterThan(0);
        }
    });

    it('marks anything leaving the app as external', () => {
        for (const d of DESTINATIONS) {
            if (d.href.startsWith('http')) expect(d.external).toBe(true);
        }
    });
});

describe('search over the map', () => {
    const find = (query: string): Destination[] => DESTINATIONS.filter((d) => matchesSearch(d, query));

    it('matches a label', () => {
        expect(find('agents').map((d) => d.id)).toContain('agents');
    });

    it('matches a keyword the label does not contain', () => {
        // Someone looking for "bot" should land on Agents; this is the whole
        // reason keywords exist.
        expect(find('bot').map((d) => d.id)).toContain('agents');
    });

    it('matches the hint text', () => {
        expect(find('remembers').map((d) => d.id)).toContain('memory');
    });

    it('is case and whitespace insensitive', () => {
        expect(find('  VOICE ').map((d) => d.id)).toContain('voice');
    });

    it('returns nothing for a word that is in no destination', () => {
        expect(find('zzzznotathing')).toEqual([]);
    });
});

/**
 * Weights.
 *
 * More renders in three tiers now, and the risk in that is quiet: a row marked
 * `hidden` leaves the rendered list, and if it also left the search index the
 * directory would have silently lost a destination. These tests are what makes
 * "hidden means unlisted, not unreachable" a fact rather than an intention.
 */
describe('destination weight', () => {
    const byId = new Map(DESTINATIONS.map((d) => [d.id, d]));

    it('promotes six and no more', () => {
        // Six fills a 2×3 grid exactly. A seventh makes a ragged row, and a
        // grid of ten is the flat list it replaced.
        const primary = DESTINATIONS.filter((d) => d.weight === 'primary');
        expect(primary).toHaveLength(6);
    });

    it('hides only rows that are genuinely reachable elsewhere', () => {
        // Every hidden row must be either a tab (visible from More already) or
        // a child of /settings (reachable by opening Settings). Hiding anything
        // else would be deleting it from the directory in all but name.
        const TABS = ['chat', 'record', 'library', 'cowork'];
        const GLOBAL = ['search', 'notifications'];
        for (const d of DESTINATIONS.filter((x) => x.weight === 'hidden')) {
            const isTab = TABS.includes(d.id);
            const isGlobal = GLOBAL.includes(d.id);
            const inSettings = d.href.startsWith('/settings/');
            expect(isTab || isGlobal || inSettings).toBe(true);
        }
    });

    it('keeps every hidden row searchable', () => {
        // The rendered list drops them; `matchesSearch` must not. This is the
        // guarantee that typing "transcribe" still finds Record.
        for (const d of DESTINATIONS.filter((x) => x.weight === 'hidden')) {
            expect(matchesSearch(d, d.label)).toBe(true);
        }
    });

    it('does not hide a destination that has no other door', () => {
        // Voice and Agents had exactly one entry point each — this list — which
        // is why they were promoted rather than left as ordinary rows.
        expect(byId.get('voice')?.weight).toBe('primary');
        expect(byId.get('agents')?.weight).toBe('primary');
    });
});
