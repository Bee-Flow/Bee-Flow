/**
 * Every navigation target must resolve to a screen that exists.
 *
 * expo-router builds its route table from the file tree, so a typo in a
 * `router.push('/notebooks')` is not a compile error — `typedRoutes` only
 * catches it when the string is a literal the checker can see, and half of
 * these are built from a template or come out of a helper. The failure mode is
 * a tap that does nothing, or a blank screen, on a path nobody exercised.
 *
 * That risk is highest exactly where this app is weakest: the screens were
 * written by several people in parallel against a shared route plan, and a
 * plan is not a guarantee. So this walks every push/replace/navigate/href in
 * the source and checks it against the actual files under app/.
 *
 * It is deliberately a test rather than a lint rule: it needs to understand
 * expo-router's own conventions — groups in parentheses that do not appear in
 * the URL, `[param]` and `[...rest]` segments, `index` files — and encoding
 * those as a rule nobody can read is worse than encoding them here.
 */

import fs from 'node:fs';
import path from 'node:path';

const APP_DIR = path.resolve(__dirname, '../../app');
const SOURCE_DIRS = [APP_DIR, path.resolve(__dirname, '..')];

/**
 * Files that define a screen.
 *
 * Two prefixes are expo-router conventions rather than destinations, and both
 * are excluded by rule instead of by name so the next one does not fail this
 * test on the day it is added: `_` is a layout (`_layout.tsx`), and `+` is a
 * router hook (`+not-found`, `+html`, `+native-intent` — the last of which
 * decides what the app does with an incoming deep link, and is emphatically
 * not somewhere a person can navigate).
 */
function isScreenFile(name: string): boolean {
    return (
        /\.(tsx|ts)$/.test(name) &&
        !name.startsWith('_') &&
        !name.startsWith('+') &&
        !name.includes('.test.')
    );
}

/**
 * Turn the app/ tree into the URL patterns expo-router will serve.
 *
 * Rules applied, all of them expo-router's:
 *   - a `(group)` directory contributes nothing to the URL;
 *   - `index` collapses to its parent path;
 *   - `[param]` matches one segment, `[...rest]` matches the remainder.
 */
function collectRoutes(dir: string, prefix = ''): string[] {
    if (!fs.existsSync(dir)) return [];
    const routes: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            const isGroup = entry.name.startsWith('(') && entry.name.endsWith(')');
            routes.push(...collectRoutes(path.join(dir, entry.name), isGroup ? prefix : `${prefix}/${entry.name}`));
        } else if (isScreenFile(entry.name)) {
            const base = entry.name.replace(/\.(tsx|ts)$/, '');
            routes.push(base === 'index' ? prefix || '/' : `${prefix}/${base}`);
        }
    }
    return routes;
}

/**
 * Strip `(group)` segments.
 *
 * Navigating to `/(tabs)` is legal and common — it is how you get to a group's
 * default screen — but a group contributes nothing to the URL, so the route
 * table has no literal `/(tabs)` entry to match against. Normalising both
 * sides the same way is what makes `/(tabs)` resolve to `/`.
 */
function stripGroups(route: string): string {
    const segments = route
        .split('/')
        .filter(Boolean)
        .filter((segment) => !(segment.startsWith('(') && segment.endsWith(')')));
    return `/${segments.join('/')}`;
}

/** Does a concrete path match a route pattern with [param] segments? */
function matches(pattern: string, target: string): boolean {
    const p = stripGroups(pattern).split('/').filter(Boolean);
    const t = stripGroups(target).split('/').filter(Boolean);
    for (let i = 0; i < p.length; i++) {
        const seg = p[i] as string;
        if (seg.startsWith('[...')) return true;
        if (seg.startsWith('[')) {
            if (t[i] === undefined) return false;
            continue;
        }
        if (seg !== t[i]) return false;
    }
    return p.length === t.length;
}

function sourceFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules') continue;
            out.push(...sourceFiles(full));
        } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.')) {
            out.push(full);
        }
    }
    return out;
}

/**
 * Pull navigation targets out of the source.
 *
 * Only literal-prefixed paths are collected. A target built entirely from a
 * variable cannot be checked here, and pretending otherwise by guessing at the
 * template would produce false failures — the interpolated segment is
 * normalised to a placeholder that matches any [param].
 */
function extractTargets(source: string): string[] {
    const targets: string[] = [];
    const push = (raw: string | undefined) => {
        if (!raw || !raw.startsWith('/')) return;
        targets.push(
            raw
                // `${id}` -> a placeholder segment, so it matches any [param].
                .replace(/\$\{[^}]*\}/g, 'PARAM')
                .split('?')[0] as string,
        );
    };

    const patterns = [
        /router\.(?:push|replace|navigate)\(\s*[`'"]([^`'"]+)[`'"]/g,
        /href=\{?\s*[`'"]([^`'"]+)[`'"]/g,
        /<Redirect\s+href=[`'"]([^`'"]+)[`'"]/g,
        /pathname:\s*[`'"]([^`'"]+)[`'"]/g,
    ];
    for (const pattern of patterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(source)) !== null) push(match[1]);
    }

    /*
     * Routes that live in DATA rather than in a call.
     *
     * Two of this app's route tables are objects, not `router.push` sites:
     * `features/sitemap/nav/destinations/` (the whole map) and
     * `features/notifications/model/route*.ts` (where a tapped notification
     * goes). (The bottom bar's tabs are pinned to their files by
     * features/shell/model/tabs.test.ts.)
     * Neither was covered by the patterns above, which is how the notification
     * table came to claim three screens were "only on the web app" while those
     * screens sat in app/ — a claim no compiler and no reader would catch.
     *
     * The value after `href:` may be a conditional rather than a literal, so
     * every quoted path on the line is collected instead of only the first.
     * A literal that is not a path (an https:// URL, `null`) fails the leading
     * slash test and drops out.
     */
    const hrefProperty = /href:\s*([^\n]*)/g;
    let property: RegExpExecArray | null;
    while ((property = hrefProperty.exec(source)) !== null) {
        const expression = property[1] ?? '';
        const literal = /[`'"]([^`'"]+)[`'"]/g;
        let value: RegExpExecArray | null;
        while ((value = literal.exec(expression)) !== null) push(value[1]);
    }

    return targets;
}

const routes = collectRoutes(APP_DIR);

describe('the route graph', () => {
    it('found the app directory and some routes', () => {
        // A refactor that moves app/ would otherwise make every test below
        // pass vacuously.
        expect(routes.length).toBeGreaterThan(10);
    });

    it('has no navigation target without a screen', () => {
        const broken: string[] = [];
        for (const file of SOURCE_DIRS.flatMap(sourceFiles)) {
            const source = fs.readFileSync(file, 'utf8');
            for (const target of extractTargets(source)) {
                if (!routes.some((route) => matches(route, target))) {
                    broken.push(`${path.relative(path.resolve(__dirname, '../..'), file)} -> ${target}`);
                }
            }
        }
        // Listed rather than counted: the point of the failure is knowing WHICH
        // link is dead and where it lives.
        expect(broken).toEqual([]);
    });

    it('serves a root route, so a cold start has somewhere to land', () => {
        expect(routes.some((route) => route === '/' || route === '')).toBe(true);
    });

    it('has no two screens claiming the same path', () => {
        const seen = new Map<string, number>();
        for (const route of routes) seen.set(route, (seen.get(route) ?? 0) + 1);
        const clashes = [...seen.entries()].filter(([, n]) => n > 1).map(([route]) => route);
        expect(clashes).toEqual([]);
    });
});

/**
 * The other half of the contract: not "does this link go somewhere" but "can
 * this somewhere be reached at all".
 *
 * `features/sitemap/nav/destinations/` states its own acceptance criterion —
 * every Bee Flow screen is reachable from the map (and so from the search) —
 * and a criterion nobody checks is a comment. Two whole screens had already
 * slipped past it by the time this test was written: a screen that exists, is
 * finished, and appears in no menu is indistinguishable from a screen that was
 * never built.
 *
 * Signed-out routes are exempt (the map is behind the auth gate), as are
 * /more (the retired More tab's address, now a redirect to the map) and
 * /sitemap (the map cannot be a destination on the map), as are `[param]`
 * screens — you arrive at a document from a list, not from a sitemap. So is
 * a `…/new` screen whose list IS on the map: it is that list's New action
 * (and the Studio's New menu), the way a document is that list's row.
 */
describe('the sitemap', () => {
    /** Static, signed-in destinations, with their `(group)` origin preserved. */
    function destinations(dir: string, prefix = '', groups: string[] = []): string[] {
        if (!fs.existsSync(dir)) return [];
        const out: string[] = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const isGroup = entry.name.startsWith('(') && entry.name.endsWith(')');
            if (entry.isDirectory()) {
                out.push(
                    ...destinations(
                        path.join(dir, entry.name),
                        isGroup ? prefix : `${prefix}/${entry.name}`,
                        isGroup ? [...groups, entry.name] : groups,
                    ),
                );
            } else if (isScreenFile(entry.name)) {
                const base = entry.name.replace(/\.(tsx|ts)$/, '');
                const route = base === 'index' ? prefix || '/' : `${prefix}/${base}`;
                if (route.includes('[')) continue;
                if (groups.includes('(onboarding)')) continue;
                if (route === '/more') continue;
                // The complete map is not a destination ON the map. It is
                // reached from the bottom of More, and listing it inside itself
                // would be circular.
                if (route === '/sitemap') continue;
                out.push(route);
            }
        }
        return out;
    }

    it('links to every screen a signed-in person can be sent to', () => {
        // The sitemap is one file per group under nav/destinations/.
        const dir = path.resolve(__dirname, '../features/sitemap/nav/destinations');
        const sitemap = fs
            .readdirSync(dir)
            .filter((name) => name.endsWith('.ts'))
            .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
            .join('\n');
        const listed = new Set(
            [...sitemap.matchAll(/href: '(\/[^']*)'/g)].map((m) => stripGroups(m[1] as string)),
        );
        const createdFromList = (route: string) =>
            route.endsWith('/new') && listed.has(stripGroups(route.slice(0, -'/new'.length)));
        const orphans = destinations(APP_DIR).filter(
            (route) => !listed.has(stripGroups(route)) && !createdFromList(route),
        );
        // Named, not counted: the fix is a row in nav/destinations/ for this screen.
        expect(orphans).toEqual([]);
    });
});
