// @vitest-environment node
/**
 * Which Content-Security-Policy the browser gets for what nginx proxies.
 *
 * The backend sends a policy of its own only where it serves something that is
 * not the app: a stored file, an image, an inline SVG, a document preview, the
 * public share viewer. Each of those carries a sandbox or `default-src 'none'`
 * policy, and that policy has to reach the browser. The SPA's own policy
 * ($csp) is for the app document and is added only to a response that arrived
 * without one.
 *
 * nginx makes that easy to lose: `proxy_hide_header` IS inherited into a
 * location until the location declares one of its own, and `add_header` is
 * inherited only while the location declares none. So this reads the template
 * the way nginx does (server level, then each location) and checks, for every
 * location that proxies to the backend, what it ends up hiding and adding.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = fs.readFileSync(path.resolve(HERE, '../nginx.conf.template'), 'utf8');

interface Directive { name: string; args: string[] }
interface Block extends Directive { children: Node[] }
type Node = Directive | Block;

const isBlock = (n: Node): n is Block => 'children' in n;

/** Words, quoted strings and the three structural characters, comments dropped. */
function tokenize(text: string): string[] {
    const tokens: string[] = [];
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '#') {
            while (i < text.length && text[i] !== '\n') i += 1;
        } else if (c === '{' || c === '}' || c === ';') {
            tokens.push(c);
            i += 1;
        } else if (c === '"' || c === "'") {
            let j = i + 1;
            while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
            tokens.push(text.slice(i + 1, j));
            i = j + 1;
        } else if (/\s/.test(c)) {
            i += 1;
        } else {
            let j = i;
            while (j < text.length && !/[\s{};]/.test(text[j])) {
                // ${VAR} is the template's own placeholder (envsubst), part of the word.
                if (text[j] === '$' && text[j + 1] === '{') j = text.indexOf('}', j);
                j += 1;
            }
            tokens.push(text.slice(i, j));
            i = j;
        }
    }
    return tokens;
}

function parse(tokens: string[]): Node[] {
    let pos = 0;
    const level = (): Node[] => {
        const out: Node[] = [];
        while (pos < tokens.length && tokens[pos] !== '}') {
            const words: string[] = [];
            while (tokens[pos] !== ';' && tokens[pos] !== '{') words.push(tokens[pos++]);
            const [name, ...args] = words;
            if (tokens[pos] === ';') {
                pos += 1;
                out.push({ name, args });
            } else {
                pos += 1;
                const children = level();
                pos += 1; // the closing brace
                out.push({ name, args, children });
            }
        }
        return out;
    };
    return level();
}

const top = parse(tokenize(TEMPLATE));
const server = top.find((n): n is Block => isBlock(n) && n.name === 'server');
if (!server) throw new Error('no server block in nginx.conf.template');
const maps = top.filter((n): n is Block => isBlock(n) && n.name === 'map');
const locations = server.children.filter((n): n is Block => isBlock(n) && n.name === 'location');

const directives = (n: Block, name: string) => n.children.filter((c) => !isBlock(c) && c.name === name);

/** The proxy_hide_header list in force: the location's own, or the server's. */
function hiddenHeaders(location: Block): string[] {
    const own = directives(location, 'proxy_hide_header');
    return (own.length ? own : directives(server!, 'proxy_hide_header')).map((d) => d.args[0].toLowerCase());
}

/** The value of the Content-Security-Policy add_header in force, or null for none. */
function addedCsp(location: Block): string | null {
    const own = directives(location, 'add_header');
    const set = own.length ? own : directives(server!, 'add_header');
    const csp = set.find((d) => d.args[0].toLowerCase() === 'content-security-policy');
    return csp ? csp.args[1] : null;
}

/** The map that defines `variable` from the backend's own policy, as { key: value } ('' = no policy sent). */
function fallbackMap(variable: string): Record<string, string> | null {
    const map = maps.find((m) => m.args[0] === '$upstream_http_content_security_policy' && m.args[1] === variable);
    if (!map) return null;
    return Object.fromEntries(map.children.map((c) => [c.name, c.args[0] ?? '']));
}

// The SPA's own renderer: it answers app and marketing paths with the app
// document, and $csp is that document's policy.
const SPA_DOCUMENT_LOCATIONS = new Set(['@render']);

const proxied = locations.filter((l) => directives(l, 'proxy_pass').length > 0);

describe('nginx: the backend policy reaches the browser', () => {
    it('parses the locations it is meant to check', () => {
        const names = proxied.map((l) => l.args.join(' '));
        expect(names).toEqual(expect.arrayContaining(['/api/', '/auth', '^~ /share/', '^~ /w/', '/uploads', '@render']));
    });

    it('never hides the backend policy on a proxied location', () => {
        for (const location of proxied) {
            expect(hiddenHeaders(location), location.args.join(' ')).not.toContain('content-security-policy');
        }
    });

    it('adds a policy of its own only when the backend sent none', () => {
        for (const location of proxied) {
            const where = location.args.join(' ');
            if (SPA_DOCUMENT_LOCATIONS.has(where)) continue;
            const value = addedCsp(location);
            expect(value, `${where} adds no Content-Security-Policy at all`).not.toBeNull();
            const map = fallbackMap(value as string);
            expect(map, `${where} adds ${value}, which is not a fallback for the backend's policy`).not.toBeNull();
            expect(map!.default, `${where}: ${value} must add nothing when the backend sent a policy`).toBe('');
            expect(map![''], `${where}: ${value} must add a policy when the backend sent none`).toBeTruthy();
        }
    });

    it('gives /api/ and the other API prefixes the SPA policy only as the fallback', () => {
        const api = locations.find((l) => l.args.join(' ') === '/api/');
        expect(api).toBeDefined();
        const value = addedCsp(api!);
        expect(value).toBe('$default_csp');
        const map = fallbackMap('$default_csp');
        expect(map!['']).toBe('$csp');
    });

    it('keeps a closed sandbox as the fallback for stored files and the share viewer', () => {
        for (const where of ['/uploads', '^~ /share/', '^~ /w/']) {
            const location = locations.find((l) => l.args.join(' ') === where)!;
            const map = fallbackMap(addedCsp(location) as string)!;
            expect(map['']).toMatch(/default-src 'none'.*sandbox/);
        }
    });
});

describe('nginx: /p/ is an app path', () => {
    it('has no location of its own, so the SPA answers it with the SPA headers', () => {
        const claims = locations.filter((l) => l.args.some((a) => a === '/p' || a.startsWith('/p/')));
        expect(claims.map((l) => l.args.join(' '))).toEqual([]);
    });
});
