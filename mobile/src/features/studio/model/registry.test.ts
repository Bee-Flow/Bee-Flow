/**
 * Every native destination the registry names is a screen that exists.
 *
 * The registry builds its routes with helpers (`route('/agents', …)`), which
 * src/meta/routes.test.ts cannot see — it reads `href:` literals. So this
 * file resolves each target against the app/ tree itself, the same way
 * expo-router does: groups contribute nothing, `index` is its folder,
 * `[param]` matches one segment, and a query string names no screen.
 */

import fs from 'node:fs';
import path from 'node:path';

import { STUDIO_SECTIONS } from './registry';
import type { StudioTarget } from './types';

const APP = path.resolve(__dirname, '../../../../app');

function routes(dir: string, prefix = ''): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const group = entry.name.startsWith('(') && entry.name.endsWith(')');
        if (entry.isDirectory()) out.push(...routes(path.join(dir, entry.name), group ? prefix : `${prefix}/${entry.name}`));
        else if (/\.tsx?$/.test(entry.name) && !/^[_+]/.test(entry.name)) {
            const base = entry.name.replace(/\.tsx?$/, '');
            out.push(base === 'index' ? prefix || '/' : `${prefix}/${base}`);
        }
    }
    return out;
}

const table = routes(APP);

function exists(href: string): boolean {
    const want = href.split('?')[0]!.split('/').filter((s) => s && !(s.startsWith('(') && s.endsWith(')')));
    return table.some((route) => {
        const have = route.split('/').filter(Boolean);
        return have.length === want.length && have.every((seg, i) => seg.startsWith('[') || seg === want[i]);
    });
}

const natives = (target: StudioTarget): string[] =>
    target.kind === 'route' ? [target.href, ...(target.detail ? [target.detail('ID')] : [])] : [];

describe('the Studio registry targets', () => {
    it('found the app directory', () => {
        expect(table.length).toBeGreaterThan(20);
    });

    it.each(STUDIO_SECTIONS.map((s) => [s.id, s] as const))('%s opens screens that exist', (_id, section) => {
        const hrefs = [...natives(section.target), ...(section.create ? natives(section.create.target) : [])];
        expect(hrefs.filter((href) => !exists(href))).toEqual([]);
    });

    it('opens the web only at a Studio address', () => {
        for (const s of STUDIO_SECTIONS) {
            for (const target of [s.target, s.create?.target]) {
                if (target?.kind === 'web') expect(target.path.startsWith(`/app/studio/${s.segment}`)).toBe(true);
            }
        }
    });

    it('has a native screen, and a native create flow, for every section', () => {
        expect(STUDIO_SECTIONS.filter((s) => s.target.kind === 'web').map((s) => s.id)).toEqual([]);
        expect(STUDIO_SECTIONS.filter((s) => s.create?.target.kind === 'web').map((s) => s.id)).toEqual([]);
    });
});
