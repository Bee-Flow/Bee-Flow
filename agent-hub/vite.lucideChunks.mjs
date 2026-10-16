/**
 * Which lucide-react modules the public entry needs, so the build can give them
 * a small chunk of their own (issue 245).
 *
 * Rolldown puts a module that two or more chunks use into a shared chunk. Every
 * lazy screen uses icons, so all of lucide's used icons (~166 KB gzipped) landed
 * in ONE shared chunk, and because the entry itself needs a few dozen icons
 * (the AppIcon registry, the marketing sections, the toaster) that whole chunk
 * was modulepreloaded on every marketing pageview. The group built from this
 * list holds only the modules the entry path uses; the rest of the icons keep
 * their own shared chunk, which imports the small one and is fetched with the
 * screens that need it.
 *
 * The icon set is read from the SOURCE of the entry path, not hand-listed, so a
 * new icon in a marketing section joins the small chunk by itself. A file that
 * is added to the entry path later (and not listed in ENTRY_ICON_SOURCES) only
 * puts its icons in the big chunk again, which the entry budget
 * (scripts/entry-budget.mjs) reports as a jump in entry JS.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Files and directories (relative to src/) whose lucide imports the entry path pulls in. */
const ENTRY_ICON_SOURCES = [
    'components/icons/iconRegistry.ts',
    'components/shared/Toast.tsx',
    'utils/integrationLogos.tsx',
    'marketing',
];

function sourceFiles(abs) {
    const st = statSync(abs);
    if (st.isFile()) return [abs];
    return readdirSync(abs).flatMap((n) => sourceFiles(path.join(abs, n)));
}

/** Names imported (not `import type`) from 'lucide-react' in one file's text. */
export function lucideNamedImports(text) {
    const names = [];
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g)) {
        for (const part of m[1].split(',')) {
            const name = part.trim().replace(/^type\s+.*/, '').split(/\s+as\s+/)[0].trim();
            if (name) names.push(name);
        }
    }
    return names;
}

/** name -> icon file ("arrow-right.mjs") from lucide's barrel. */
export function barrelFiles(barrelText) {
    const byName = new Map();
    for (const m of barrelText.matchAll(/export\s*\{([^}]*)\}\s*from\s*'\.\/icons\/([^']+)'/g)) {
        for (const part of m[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/).pop();
            if (name) byName.set(name, m[2]);
        }
    }
    return byName;
}

/** The set of lucide icon file names (e.g. "arrow-right.mjs") the entry path uses. */
export function entryIconFiles(srcRoot, lucideEsmDir) {
    const barrel = barrelFiles(readFileSync(path.join(lucideEsmDir, 'lucide-react.mjs'), 'utf8'));
    const files = new Set();
    for (const rel of ENTRY_ICON_SOURCES) {
        for (const f of sourceFiles(path.join(srcRoot, rel))) {
            if (!/\.(tsx?|jsx?)$/.test(f) || /\.test\.[jt]sx?$/.test(f)) continue;
            for (const name of lucideNamedImports(readFileSync(f, 'utf8'))) {
                const file = barrel.get(name);
                if (file) files.add(file);
            }
        }
    }
    return files;
}

/**
 * Test function for a Rolldown code-splitting group: lucide's base modules
 * (createLucideIcon, Icon, shared utils) and the icons the entry path uses.
 */
export function lucideEntryTest(srcRoot, lucideEsmDir) {
    const icons = entryIconFiles(srcRoot, lucideEsmDir);
    // Module ids are real paths and node_modules may be a symlink (a worktree),
    // so match the package-relative part, not the resolved directory.
    const MARK = 'node_modules/lucide-react/dist/esm/';
    return (id) => {
        const p = id.replace(/\\/g, '/').split('?')[0];
        if (!p.includes(MARK) || p.endsWith('/lucide-react.mjs') || p.endsWith('/dynamicIconImports.mjs')) return false;
        if (p.includes('/icons/')) return icons.has(p.slice(p.lastIndexOf('/') + 1));
        return true;
    };
}
