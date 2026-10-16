// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * The registry (studioRegistry.tsx) lazy-imports every Studio section. When a
 * file inside a section imported it back — PhaseRail for a lock hint,
 * NewFormDialog for the form POST — every section joined one import cycle
 * with the registry. The helpers those files need live in studioGates.ts and
 * api/queries/automation/createDraft.ts now; this keeps it that way.
 *
 * studioApps.jsx counts as the registry: it re-exports it for the files that
 * legitimately list sections (the shell, the sidebar, the New menu), all of
 * which sit at the Studio root or outside Studio.
 *
 * Tests are exempt: a test may well want the real section list.
 */

const STUDIO = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_MODULES = ['studioRegistry', 'studioApps'].map((name) => path.join(STUDIO, name));
const SOURCE = /\.(jsx?|tsx?)$/;
const TEST_FILE = /\.test\.(jsx?|tsx?)$/;
// Static `from '…'`, side-effect `import '…'`, dynamic `import('…')`, and `require('…')`.
const SPECIFIER = /(?:\bfrom\s*|^\s*import\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/gm;

function walk(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, acc);
        else if (SOURCE.test(entry.name) && !TEST_FILE.test(entry.name)) acc.push(full);
    }
    return acc;
}

/** Every non-test source file in a section folder (Studio/<dir>/**), not the Studio root. */
function sectionFiles(): string[] {
    return fs.readdirSync(STUDIO, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => walk(path.join(STUDIO, entry.name)));
}

/** The relative specifiers a file imports, resolved to absolute paths without extension. */
function resolvedImports(file: string): string[] {
    const src = fs.readFileSync(file, 'utf8');
    return [...src.matchAll(SPECIFIER)]
        .map((m) => m[1])
        .filter((spec) => spec.startsWith('.'))
        .map((spec) => path.resolve(path.dirname(file), spec.replace(/\?.*$/, '')).replace(/\.(jsx?|tsx?)$/, ''));
}

describe('Studio section folders never import the registry', () => {
    const files = sectionFiles();

    it('finds the section folders (the scan is not vacuous)', () => {
        expect(files.length).toBeGreaterThan(50);
        const rel = files.map((f) => path.relative(STUDIO, f).split(path.sep).join('/'));
        expect(rel).toContain('Playbooks/PhaseRail.tsx');
        expect(rel).toContain('Forms/NewFormDialog.tsx');
        // …and the specifier scan sees the imports that replaced the registry's.
        const gates = path.join(STUDIO, 'studioGates');
        expect(resolvedImports(path.join(STUDIO, 'Playbooks/PhaseRail.tsx'))).toContain(gates);
        expect(resolvedImports(path.join(STUDIO, 'Forms/NewFormDialog.tsx'))).toContain(gates);
    });

    it('no file under Studio/*/ imports studioRegistry or the studioApps re-export', () => {
        const offenders = files
            .filter((file) => resolvedImports(file).some((target) => REGISTRY_MODULES.includes(target)))
            .map((file) => path.relative(STUDIO, file).split(path.sep).join('/'));
        expect(offenders, 'import studioGates.ts (gates, lock hints, createFormAutomation) or api/queries/automation/createDraft.ts instead').toEqual([]);
    });
});
