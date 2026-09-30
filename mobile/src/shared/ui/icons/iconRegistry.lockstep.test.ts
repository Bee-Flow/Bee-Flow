/**
 * Every icon name the web can store, the phone can draw — as the same glyph.
 *
 * `app.icon`, a CMS block's `icon` and friends hold names from the web's
 * ICON_REGISTRY (agent-hub/src/components/icons/iconRegistry.js). The phone's
 * registry is generated from that file (scripts/sync-web-icons.mjs); this
 * reads the web file as text — Metro and this Jest project cannot load it —
 * and checks the result:
 *
 *   - every web name is a key on the phone;
 *   - it is the SAME Lucide glyph: several web names are Lucide's older
 *     aliases (HelpCircle is now CircleQuestionMark), so the component's
 *     displayName is checked against the file lucide-react-native@0.562
 *     itself maps the name to;
 *   - the phone falls back to the web's FALLBACK_ICON.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ICON_REGISTRY, WEB_FALLBACK_ICON, WEB_ICON_NAMES } from './registry.generated';

const MOBILE = path.resolve(__dirname, '../../../..');
const WEB_REGISTRY = path.resolve(MOBILE, '../agent-hub/src/components/icons/iconRegistry.js');
const LUCIDE_BARREL = path.join(MOBILE, 'node_modules/lucide-react-native/dist/esm/lucide-react-native.js');

const webSrc = fs.readFileSync(WEB_REGISTRY, 'utf8');

function webNames(): string[] {
    const body = /export const ICON_REGISTRY\s*=\s*\{([\s\S]*?)\};/.exec(webSrc)?.[1] ?? '';
    return body
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

/** Lucide export name → the icon file it comes from, per the package barrel. */
function lucideFiles(): Map<string, string> {
    const files = new Map<string, string>();
    const src = fs.readFileSync(LUCIDE_BARREL, 'utf8');
    for (const m of src.matchAll(/export \{([^}]*)\} from '\.\/icons\/([a-z0-9-]+)\.js'/g)) {
        for (const part of (m[1] ?? '').split(',')) files.set(part.trim().replace(/^default as /, ''), m[2] as string);
    }
    return files;
}

/** The name an icon file gives its component: `createLucideIcon("CircleQuestionMark", …)`. */
function glyphName(file: string): string | undefined {
    const src = fs.readFileSync(path.join(path.dirname(LUCIDE_BARREL), 'icons', `${file}.js`), 'utf8');
    return /createLucideIcon\("([^"]+)"/.exec(src)?.[1];
}

describe('icon registry vs the web', () => {
    const names = webNames();
    const files = lucideFiles();
    const registry = ICON_REGISTRY as Record<string, { displayName?: string } | undefined>;

    it('parses the web registry', () => {
        // A regex that silently matched nothing would pass every check below.
        expect(names.length).toBeGreaterThan(100);
        expect(names).toContain('LayoutGrid');
    });

    it('holds every web name', () => {
        expect(names.filter((name) => !registry[name])).toEqual([]);
        expect([...WEB_ICON_NAMES]).toEqual(names);
    });

    it('draws the glyph Lucide maps each name to', () => {
        const wrong = Object.keys(registry).filter((name) => {
            const file = files.get(name);
            return !file || registry[name]?.displayName !== glyphName(file);
        });
        expect(wrong).toEqual([]);
        expect(registry.HelpCircle?.displayName).toBe('CircleQuestionMark');
    });

    it("falls back to the web's FALLBACK_ICON", () => {
        const webFallback = /export const FALLBACK_ICON\s*=\s*([A-Za-z0-9]+);/.exec(webSrc)?.[1];
        expect(WEB_FALLBACK_ICON).toBe(webFallback);
    });
});
