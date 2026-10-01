/**
 * The vendored mapping core is the server's, byte for byte.
 *
 * server/shared/mapping is the source; agent-hub/src/shared/mapping and this
 * vendor/ are generated copies (`npm run gen:shared`). The server resolves
 * every step input with it and the builders preview with it, so a copy that
 * differs is a preview that lies. This is a BYTE test, not a behaviour test
 * (corpus.test.ts is that): a difference of any kind fails, including a
 * reformat.
 *
 * When it fails, run `npm run gen:shared` at the repo root — never edit the
 * files here.
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../../../..');
const VENDOR = path.join(__dirname, 'vendor');
const ORIGINALS = ['server/shared/mapping', 'agent-hub/src/shared/mapping'];

const isTest = (name: string) => /\.(test|spec)\.[^.]+$/.test(name);
const sourceFiles = fs.readdirSync(path.join(REPO, ORIGINALS[0] as string)).filter((f) => !isTest(f)).sort();

describe('vendor/ is a verbatim copy of the shared mapping core', () => {
    it('holds every file the server has, and nothing else', () => {
        expect(sourceFiles).toEqual(expect.arrayContaining(['corpus.mjs', 'index.d.mts', 'index.mjs', 'legacy.mjs']));
        expect(fs.readdirSync(VENDOR).sort()).toEqual(sourceFiles);
    });

    it.each(ORIGINALS.flatMap((dir) => sourceFiles.map((file) => [dir, file] as const)))('%s/%s', (dir, file) => {
        const original = fs.readFileSync(path.join(REPO, dir, file));
        const copy = fs.readFileSync(path.join(VENDOR, file));
        expect(original.length).toBeGreaterThan(100);
        expect(copy.equals(original)).toBe(true);
    });

    it('declares every name index.mjs exports, and no other', () => {
        const index = fs.readFileSync(path.join(VENDOR, 'index.mjs'), 'utf8');
        const exported = [...index.matchAll(/export\s*\{([^}]*)\}/g)]
            .flatMap((m) => (m[1] ?? '').split(','))
            .map((s) => s.trim())
            .filter(Boolean)
            .sort();
        const decl = fs.readFileSync(path.join(VENDOR, 'index.d.mts'), 'utf8');
        const declared = [...decl.matchAll(/export declare (?:class|function|const) (\w+)/g)]
            .map((m) => m[1] as string)
            .sort();
        expect(exported.length).toBeGreaterThan(5);
        expect(declared).toEqual(exported);
    });
});
