/**
 * The sitemap is the app's claim that every Bee Flow feature is reachable
 * from a phone — through the A–Z map and the global search, whatever the
 * drawer and the tabs happen to show. This is the test that makes the claim
 * checkable.
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

import { buildAccessSnapshot } from '@/core/access';
import type { User } from '@/core/auth/types';

import { DESTINATIONS } from './destinations';
import { isReachable, matchesSearch } from './search';
import { GROUP_ORDER, type Destination } from './types';

const APP_DIR = path.resolve(__dirname, '../../../../app');

/**
 * Routes that are legitimately absent from the map.
 *
 * The signed-out flow is not a set of destinations — you do not navigate to
 * "MFA", the auth state machine takes you there — and `/more` is the old
 * More tab's address, kept only as a redirect to the map. Everything else must
 * be listed, and adding to this set should feel uncomfortable.
 */
const NOT_DESTINATIONS = new Set([
    '/more',
    // The complete map itself. Listing it as a destination on the map would be
    // circular; the drawer's profile menu opens it.
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
                // destinations — see isScreenFile in src/meta/routes.test.ts.
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
    // Keep one level deep, plus the settings/, org/, studio/ and knowledge/
    // children the map does list individually.
    return [...new Set(found)].filter((route) => {
        const depth = route.split('/').filter(Boolean).length;
        if (depth <= 1) return true;
        return (
            route.startsWith('/settings/') ||
            route.startsWith('/org/') ||
            route.startsWith('/studio/') ||
            route === '/knowledge/documents'
        );
    });
}

const linked = new Set(DESTINATIONS.map((d) => d.href));

describe('the sitemap is a complete map', () => {
    it('found the app directory', () => {
        expect(topLevelRoutes().length).toBeGreaterThan(20);
    });

    it('links every screen a user is meant to navigate to', () => {
        const unreachable = topLevelRoutes()
            .filter((route) => !NOT_DESTINATIONS.has(route))
            .filter((route) => !linked.has(route));
        // Named, not counted: the useful failure says which screen nobody can
        // reach.
        expect(unreachable).toEqual([]);
    });

    it('has no destination pointing at a screen that does not exist', () => {
        const routes = new Set(topLevelRoutes());
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
        expect(find('persisted').map((d) => d.id)).toContain('memory');
    });

    it('is case and whitespace insensitive', () => {
        expect(find('  VOICE ').map((d) => d.id)).toContain('voice');
    });

    it('returns nothing for a word that is in no destination', () => {
        expect(find('zzzznotathing')).toEqual([]);
    });
});

describe('the organisation settings', () => {
    // The web's global admin dashboard is not on the phone; an organisation
    // administrator reaches their settings through Organisation, and a member
    // is not offered them.
    const shield = DESTINATIONS.find((d) => d.id === 'org-shield') as Destination;
    const compliance = DESTINATIONS.find((d) => d.id === 'org-compliance') as Destination;
    const who = (over: Partial<User>, permissions: string[] | null) =>
        buildAccessSnapshot({
            user: { id: 'u1', displayName: 'Ada', isAdmin: false, role: 'user', provider: 'local', ...over },
            permissions: permissions ? { permissions, groups: [], organizations: [], allowedAgentTypes: [] } : null,
        });

    it('has no Administration row', () => {
        expect(DESTINATIONS.find((d) => d.href === '/admin')).toBeUndefined();
    });

    it('offers the org-admin sections to an organisation administrator', () => {
        expect(isReachable(shield, who({ orgRole: 'org_admin' }, ['org_admin']))).toBe(true);
    });

    it('does not offer them to a member, nor Compliance to anyone without admin_compliance', () => {
        expect(isReachable(shield, who({}, ['use_notebooks', 'use_apps']))).toBe(false);
        expect(isReachable(compliance, who({}, ['use_notebooks']))).toBe(false);
    });
});
