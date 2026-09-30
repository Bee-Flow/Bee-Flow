/**
 * ci.yml's mobile filter leaves the server's dependency manifests out, and a
 * job that does not fire produces no red.
 *
 * That is the whole reason this file exists. The server half of the mobile
 * filter (the FIRST `mobile:` block in ci.yml, in the `changes` job) lists the
 * server files mobile reads, not server/** (./serverClosure.test.ts keeps that
 * list complete), so dependabot's server bumps do not re-run the entire mobile
 * pipeline for a change that cannot alter a mobile test outcome. Leaving the
 * manifests out is safe only while two things stay true:
 *
 *   1. no mobile test reads those manifests (or the server's node_modules), and
 *   2. jest still loads the server tree untransformed, via SERVER_DIR in
 *      transformIgnorePatterns — the line that exists because "the server's
 *      node_modules are not installed in the mobile CI job".
 *
 * Break either one and nothing goes red, because the job that would have gone
 * red is exactly the one no longer firing. So the assumptions are asserted
 * here instead, in a suite that DOES run on `mobile/**` and on ci.yml.
 *
 * Parsing is line-based on purpose: neither the mobile nor the server
 * manifest carries a yaml dependency, and pinning a workflow file line-wise
 * is the house method (see ./androidCiTrigger.test.ts).
 *
 * If this goes red, restore the invariant or revert the exclusion. Do not
 * relax an assertion.
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../../..');
const MOBILE_SRC = path.resolve(__dirname, '..');
const WORKFLOW = path.join(REPO, '.github/workflows/ci.yml');

/** The lines of the `mobile:` filter block starting at `at`, trimmed. */
function blockAt(lines: string[], at: number): string[] {
    const indent = (lines[at] ?? '').search(/\S/);
    const out: string[] = [];
    for (let i = at + 1; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        if (line.trim() === '') continue;
        if (line.search(/\S/) <= indent) break;
        out.push(line.trim());
    }
    return out;
}

const isMobileKey = (l: string) => /^ {10,}mobile:\s*$/.test(l);

/** The FIRST `mobile:` filter block inside the changes job: the server half. */
function mobileFilterLines(lines: string[]): string[] {
    const at = lines.findIndex(isMobileKey);
    expect(at).toBeGreaterThan(-1);
    return blockAt(lines, at);
}

/** The patterns of every `mobile:` filter block, comments dropped. */
function allMobilePatterns(lines: string[]): string[] {
    return lines
        .flatMap((l, at) => (isMobileKey(l) ? blockAt(lines, at) : []))
        .filter((l) => !l.startsWith('#'))
        .map((l) => l.replace(/^-\s+/, '').replace(/^(['"])(.*)\1$/, '$2'));
}

describe("ci.yml's mobile filter leaves the server dependency manifests out", () => {
    const lines = fs.readFileSync(WORKFLOW, 'utf8').split('\n');
    // Assembled, not written out, so that the "no mobile test reads the server
    // dependency manifests" assertion below does not match THIS file and mask
    // a real reader.
    const MANIFESTS = ['server/' + 'package.json', 'server/' + 'package-lock.json'];

    it('lists server files in the server half: no server/**, no negation', () => {
        const block = mobileFilterLines(lines).filter((l) => !l.startsWith('#'));
        // Empty means the mobile job no longer fires on server changes at all.
        expect(block.length).toBeGreaterThan(0);
        const why = (l: string): string | null => {
            if (l === "- 'server/**'") return 're-runs the mobile pipeline on every server change, manifests included';
            if (l.startsWith("- '!")) return 'is a negation, which dorny reads as "every path except this one"';
            if (!/^- 'server\/[^']+'$/.test(l)) return 'is not a quoted server/ pattern';
            return null;
        };
        const offenders = block
            .filter((l) => why(l) !== null)
            .map((l) => `${l} in the server half of the mobile filter ${why(l)}`);
        // Named, not counted: the fix is a pattern for the file mobile reads,
        // never a broader one.
        expect(offenders).toEqual([]);
    });

    it('no pattern under any `mobile:` key matches a server manifest', () => {
        const patterns = allMobilePatterns(lines);
        expect(patterns.length).toBeGreaterThan(0);
        // dorny ORs the patterns of a filter, and reads `!x` as every path
        // except x — which includes the manifests.
        const hits = (file: string, p: string) =>
            p.startsWith('!') ? !path.posix.matchesGlob(file, p.slice(1)) : path.posix.matchesGlob(file, p);
        const offenders = MANIFESTS.flatMap((file) =>
            patterns.filter((p) => hits(file, p)).map((p) => `'${p}' matches ${file}`),
        );
        expect(offenders).toEqual([]);
    });
});

describe('the assumptions that make the exclusion safe', () => {
    /**
     * Every mobile test file, enumerated completely rather than grepped for a
     * path shape — a grep for a path shape is the method that missed
     * sitemap.i18n.test.ts four times.
     */
    function testFiles(dir: string, out: string[] = []): string[] {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules') continue;
                testFiles(full, out);
            } else if (/\.test\.tsx?$/.test(entry.name)) {
                out.push(full);
            }
        }
        return out;
    }

    it('no mobile test reads the server dependency manifests', () => {
        // Assembled rather than written out, so this file's own assertions do
        // not match themselves — and so would not mask a real reader.
        const forbidden = ['server/' + 'package.json', 'server/' + 'package-lock.json', 'server/' + 'node_modules'];
        const files = testFiles(MOBILE_SRC);
        expect(files.length).toBeGreaterThan(0);

        const offenders: string[] = [];
        for (const file of files) {
            const text = fs.readFileSync(file, 'utf8');
            for (const needle of forbidden) {
                if (text.includes(needle)) offenders.push(`${path.relative(REPO, file)} reads ${needle}`);
            }
        }
        // Named, not counted: a test that reads these makes the exclusion
        // unsafe, because mobile-checks no longer fires when they change.
        expect(offenders).toEqual([]);
    });

    it('the server tree is still loaded without its node_modules', () => {
        const config = fs.readFileSync(path.resolve(__dirname, '../../jest.config.js'), 'utf8');
        const array = /transformIgnorePatterns:\s*\[([\s\S]*?)\]/.exec(config);
        expect(array).not.toBeNull();
        // Drop SERVER_DIR and the server's uninstalled node_modules become
        // reachable through Babel again; the exclusion stops being safe.
        expect((array as RegExpExecArray)[1]).toContain('SERVER_DIR');
    });
});
