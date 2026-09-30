/**
 * "Describe it" held to its three sources (textual lockstep):
 *
 *   - the route, server/routes/studio/aiRoute.js: its address, the statuses
 *     and codes it refuses with, the shape it answers, and the kinds it may
 *     route to — each of which must be a kit kind with a New-menu door here;
 *   - the web client, agent-hub/.../studioAi/routeApi.js and
 *     DescribeItPanel.jsx: the same codes, the same status fallback, the same
 *     sentences under the same keys;
 *   - the phone's own create screens: none reads a name or a brief, which is
 *     what the card's two caveats claim (model/describeIt.ts). When one learns
 *     to, this fails: pass it along, and drop the caveat for that kind.
 *
 * When this fails, the other side changed: update the port, don't loosen the test.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CLIENT_DICT, SERVER_DICT, readDict } from '@/core/i18n/dictionaryText';
import { KIND_KEYS } from '@/shared/ui';

import { DESCRIBE_IT_WORDS, ROUTE_ERROR_CODES } from './describeIt';
import { sectionForKind } from './links';

const REPO = path.resolve(__dirname, '../../../../..');
const MOBILE = path.join(REPO, 'mobile');
const read = (...parts: string[]) => fs.readFileSync(path.join(REPO, ...parts), 'utf8');

const ROUTE = read('server/routes/studio/aiRoute.js');
const WEB_API = read('agent-hub/src/components/admin/Studio/studioAi/routeApi.js');
const WEB_PANEL = read('agent-hub/src/components/admin/Studio/studioAi/DescribeItPanel.jsx');

/** The text between `start` and the first `end` after it. */
function block(src: string, start: string, end: string): string {
    const at = src.indexOf(start);
    expect(at).toBeGreaterThanOrEqual(0);
    return src.slice(at, src.indexOf(end, at));
}

/** ROUTE_KINDS' keys, in order: the vocabulary the model is given. */
const routeKinds = [...block(ROUTE, 'const ROUTE_KINDS = Object.freeze([', '\n]);').matchAll(/\n {8}key: '(\w+)'/g)].map((m) => m[1] as string);

describe('the route (server/routes/studio/aiRoute.js)', () => {
    it('is POST /api/studio/ai/route', () => {
        expect(ROUTE).toContain("router.post('/ai/route'");
        expect(read('server/index.js')).toContain("app.use('/api/studio', requireAuthedUser, require('./routes/studio/aiRoute'));");
    });

    it('takes { text } and nothing else', () => {
        expect(block(ROUTE, 'const RouteBody', '.strict()')).toMatch(/\btext: z\.string\(/);
    });

    it('refuses with the statuses and codes the phone reads', () => {
        const refusals = [...ROUTE.matchAll(/status\((\d{3})\)\.json\(\{[^}]*?code: '(\w+)'/g)].map((m) => [Number(m[1]), m[2]]);
        expect(refusals).toEqual([
            [400, 'no_text'],
            [503, 'no_model'],
            [502, 'ai_unusable'],
        ]);
        // 429 comes from the per-user limiter, with a sentence and no code: the status decides.
        expect(ROUTE).toMatch(/router\.post\('\/ai\/route', limiter,/);
    });

    it('answers { kind, name, seed, companions, available, undecided }', () => {
        expect(ROUTE).toContain('return res.json({ kind: null, name: null, seed: null, companions: [], available, undecided });');
        expect(ROUTE).toContain('return { kind, name, seed, companions };');
        expect(ROUTE).toContain('return res.json({ ...parsed, available, undecided });');
        expect(ROUTE).toContain("companions.push({ kind: cKind, name: cName, why: clampText(raw.why, MAX_WHY_CHARS) });");
    });

    it('routes only to kit kinds that have a door in the New menu', () => {
        expect(routeKinds.length).toBeGreaterThanOrEqual(9);
        for (const kind of routeKinds) {
            expect({ kind, known: (KIND_KEYS as readonly string[]).includes(kind) }).toEqual({ kind, known: true });
            expect({ kind, create: Boolean(sectionForKind(kind)?.create) }).toEqual({ kind, create: true });
        }
    });
});

describe('the web client (studioAi/routeApi.js, DescribeItPanel.jsx)', () => {
    it('knows the same five codes', () => {
        const web = /ROUTE_ERROR_CODES = Object\.freeze\(\[([^\]]+)\]\)/.exec(WEB_API)?.[1] ?? '';
        expect([...web.matchAll(/'(\w+)'/g)].map((m) => m[1])).toEqual([...ROUTE_ERROR_CODES]);
    });

    it('falls back on the same statuses', () => {
        const web = block(WEB_API, 'const CODE_BY_STATUS', '});');
        expect([...web.matchAll(/(\d{3}): '(\w+)'/g)].map((m) => [Number(m[1]), m[2]])).toEqual([
            [400, 'no_text'],
            [429, 'rate_limited'],
            [502, 'ai_unusable'],
            [503, 'no_model'],
        ]);
    });

    it('says the same sentences under the same keys (the phone adds only "offline")', () => {
        const web = block(WEB_PANEL, 'const ERROR_TEXT = {', '\n};');
        const theirs = Object.fromEntries([...web.matchAll(/\n {4}(\w+): \['([\w.]+)', '([^']+)'\]/g)].map((m) => [m[1], [m[2], m[3]]]));
        const { offline, ...ours } = DESCRIBE_IT_WORDS;
        expect(Object.keys(theirs)).toHaveLength(7);
        expect(ours).toEqual(theirs);
        expect(offline[0].startsWith('mobile.')).toBe(true);
    });
});

describe('the words', () => {
    const server = readDict(SERVER_DICT);
    const client = readDict(CLIENT_DICT);
    const components = ['DescribeItSheet', 'DescribeItPlanCard', 'DescribeItCaveats', 'DescribeItBlock']
        .map((name) => fs.readFileSync(path.join(__dirname, `../components/${name}.tsx`), 'utf8'))
        .join('\n');
    const borrowed: [string, string][] = [
        ...[...components.matchAll(/t\(\s*'(studio\.ai\.\w+)',\s*'([^']+)'/g)].map((m) => [m[1], m[2]] as [string, string]),
        ...Object.values(DESCRIBE_IT_WORDS).filter(([key]) => !key.startsWith('mobile.')).map(([k, v]) => [k, v] as [string, string]),
    ];

    it('borrows the web\'s keys, in both dictionaries, with the web\'s English', () => {
        expect(borrowed.length).toBeGreaterThan(20);
        for (const [key, english] of borrowed) {
            expect({ key, server: server.get(key), client: client.get(key) }).toEqual({ key, server: english, client: english });
        }
    });
});

describe('the create screens behind the doors', () => {
    /** `/skills?new=1` → app/skills/index.tsx (or app/skills.tsx). */
    const routeFile = (href: string): string => {
        const route = href.split('?')[0] as string;
        const flat = path.join(MOBILE, 'app', `${route}.tsx`);
        return fs.existsSync(flat) ? flat : path.join(MOBILE, 'app', route, 'index.tsx');
    };

    it.each(routeKinds)('%s: the screen reads no name and no brief', (kind) => {
        const target = sectionForKind(kind)?.create?.target;
        expect(target?.kind).toBe('route');
        const src = fs.readFileSync(routeFile(target?.kind === 'route' ? target.href : ''), 'utf8');
        const params = [...src.matchAll(/useLocalSearchParams<\{([^}]*)\}>/g)].flatMap((m) =>
            [...(m[1] ?? '').matchAll(/(\w+)\??:/g)].map((p) => p[1] as string),
        );
        expect(params.filter((p) => /name|title|seed|brief|prompt|text|description/i.test(p))).toEqual([]);
    });
});
