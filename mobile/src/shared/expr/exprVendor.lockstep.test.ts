/**
 * The vendored expression engine is the web's, byte for byte.
 *
 * agent-hub/src/shared/expr and server/shared/expr are the same files;
 * the server runs automations with them and the web builder checks conditions
 * with them. The phone's copy in vendor/ has to be a third identical copy, or
 * a condition the phone accepts is one the server rejects (or evaluates
 * differently). This is a BYTE test, not a behaviour test: a difference of any
 * kind fails, including a reformat.
 *
 * When it fails, copy the web's files over vendor/ — never edit them here.
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../../../..');
const VENDOR = path.join(__dirname, 'vendor');
const ENGINE_FILES = ['engine.mjs', 'functions.mjs', 'index.mjs', 'parse.mjs', 'topics.mjs'];
const ORIGINALS = ['agent-hub/src/shared/expr', 'server/shared/expr'];

const bytes = (file: string) => fs.readFileSync(file);

describe('vendor/ is a verbatim copy of the shared engine', () => {
    it.each(ORIGINALS.flatMap((dir) => ENGINE_FILES.map((file) => [dir, file] as const)))(
        '%s/%s',
        (dir, file) => {
            const original = bytes(path.join(REPO, dir, file));
            const copy = bytes(path.join(VENDOR, file));
            expect(original.length).toBeGreaterThan(100);
            expect(copy.equals(original)).toBe(true);
        },
    );

    it('holds the engine and its type declaration, and nothing else', () => {
        expect(fs.readdirSync(VENDOR).sort()).toEqual([...ENGINE_FILES, 'index.d.mts'].sort());
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
