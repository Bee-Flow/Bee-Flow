/**
 * android-release.yml no longer runs Gradle on every mobile PR.
 *
 * Its `guard` job decides, from a fenced list of path patterns, whether a PR
 * can break the NATIVE build. If it cannot, the ~15-minute APK build is
 * skipped and the mobile job in ci.yml (lint, typecheck, unit tests, `expo prebuild`)
 * is the whole gate. That list is the only thing standing between a native
 * regression and a green PR, and a list is exactly the kind of thing that goes
 * stale when a directory is renamed.
 *
 * So the list is asserted here. It lives in mobile/src/lib because jest's
 * testMatch is `<rootDir>/src/**\/*.test.ts` and mobile/src/lib/
 * nativeDeps.test.ts is the existing precedent for a test in this directory
 * that guards build-level facts rather than a sibling module. The mobile CI job
 * carries `.github/workflows/android-release.yml` in its pull_request paths
 * precisely so this test runs when the list is edited.
 *
 * The right response to a failure here is to ADD a pattern. Never relax an
 * assertion — a relaxed assertion here buys back the saving by giving up the
 * thing the saving was supposed to be safe because of.
 *
 * No new dependency: js-yaml is only a transitive dep of mobile, so the
 * sentinel-fenced region is parsed textually.
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../../..');
const WORKFLOW = path.join(REPO, '.github/workflows/android-release.yml');
const workflowText = fs.readFileSync(WORKFLOW, 'utf8');

/**
 * The patterns between the two sentinels. An empty extraction must FAIL, not
 * make every assertion below vacuously true.
 */
function nativePatterns(): RegExp[] {
    const begin = workflowText.indexOf('# NATIVE_PATHS_BEGIN');
    const end = workflowText.indexOf('# NATIVE_PATHS_END');
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    const raw = workflowText
        .slice(begin, end)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('^'));
    expect(raw.length).toBeGreaterThanOrEqual(5);
    return raw.map((p) => new RegExp(p));
}

const PATTERNS = nativePatterns();
const matches = (file: string) => PATTERNS.some((p) => p.test(file));

/** Every real repo-relative path the filter could ever be shown. */
function candidatePaths(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else out.push(path.relative(REPO, full).split(path.sep).join('/'));
        }
    };
    walk(path.join(REPO, 'mobile'));
    for (const f of fs.readdirSync(path.join(REPO, '.github/workflows'))) {
        out.push(`.github/workflows/${f}`);
    }
    out.push('.nvmrc');
    return out;
}

describe('android-release.yml native-path filter', () => {
    it('covers every file that can break the native build today', () => {
        const mustBuild = [
            'mobile/package.json',
            'mobile/package-lock.json',
            'mobile/app.config.ts',
            'mobile/plugins/withBeeFlowAndroid.js',
            'mobile/modules/beeflow-argon2/android/build.gradle',
            'mobile/modules/beeflow-argon2/android/src/main/java/expo/modules/beeflowargon2/BeeFlowArgon2Module.kt',
            'mobile/metro.config.js',
            'mobile/babel.config.js',
            'mobile/assets/icon.png',
            '.nvmrc',
            '.github/workflows/android-release.yml',
        ];
        // Named, not counted: each of these, changed alone, must still start a
        // Gradle build.
        expect(mustBuild.filter((f) => !matches(f))).toEqual([]);
    });

    it('keeps the skip that pays for this', () => {
        // THE anti-regression for the saving. Re-add a broad `^mobile/` and
        // this is what catches it.
        const mustSkip = [
            'mobile/src/features/chat/prompts.ts',
            'mobile/app/index.tsx',
            'mobile/src/i18n/nl.ts',
            'mobile/README.md',
            'mobile/eslint.config.js',
            'mobile/jest.config.js',
        ];
        expect(mustSkip.filter((f) => matches(f))).toEqual([]);
    });

    it('has no dead pattern', () => {
        // The rename detector: move mobile/plugins/ or mobile/modules/ and the
        // pattern silently stops protecting native code.
        const candidates = candidatePaths();
        expect(candidates.length).toBeGreaterThan(0);
        const dead = PATTERNS.filter((p) => !candidates.some((f) => p.test(f))).map((p) => p.source);
        expect(dead).toEqual([]);
    });

    it('covers locally authored native code wherever it lands', () => {
        // Today that is only mobile/modules/beeflow-argon2/**. A second local
        // native module outside mobile/modules/ fails this until the list is
        // updated — which is exactly the failure mode this narrowing risks:
        // native breakage green on a PR, red on main.
        const nativeish = candidatePaths().filter(
            (f) => /(^|\/)android\/.*build\.gradle(\.kts)?$/.test(f) || /\.(kt|java|cpp|h)$/.test(f) || /CMakeLists\.txt$/.test(f),
        );
        expect(nativeish.length).toBeGreaterThan(0);
        expect(nativeish.filter((f) => !matches(f))).toEqual([]);
    });

    it('keeps the label escape hatch wired', () => {
        // Lose any one of these and the label becomes a no-op, or the gate
        // becomes an always-skip.
        for (const needle of [
            'types: [opened, synchronize, reopened, labeled]',
            "contains(github.event.pull_request.labels.*.name, 'android-apk')",
            "needs.guard.outputs.build_apk == 'true'",
            'build_apk: ${{ steps.decide.outputs.build_apk }}',
        ]) {
            expect(workflowText).toContain(needle);
        }
    });

    it('keeps the public-repository fences wired', () => {
        // Textual tripwires, like the rest of this file. A fork's APK is never
        // uploaded, and no step reads a repository secret at all: the upload
        // key lives with Bee Flow's private release pipeline, which signs the
        // AAB this workflow publishes (see NO SIGNING KEY LIVES HERE in its
        // header). A `secrets.` reference coming back means a key is about to
        // be handed to whatever code a branch holds.
        const lines = workflowText.split('\n');
        const uploads = lines.flatMap((l, i) => (l.includes('uses: actions/upload-artifact@') ? [lines[i - 1]?.trim()] : []));
        expect(uploads).toEqual([
            "if: ${{ !(github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository) }}",
        ]);
        const secretSteps = workflowText.split(/\n(?= {6}- )/).filter((step) => step.includes('secrets.'));
        expect(secretSteps).toEqual([]);
    });

    it('keeps non-PR events and API failures building', () => {
        // This assertion is TEXTUAL and therefore weak: it is a tripwire
        // against deletion, not a behavioural test of the shell. A behavioural
        // test would need a bash harness, which is not worth it for a ten-line
        // script, and `act` is not available here.
        expect(workflowText).toContain('if [[ "$EVENT" != "pull_request" ]]');
        expect(workflowText).toContain('if ! CHANGED=');
        const nonPr = workflowText.slice(workflowText.indexOf('if [[ "$EVENT" != "pull_request" ]]'));
        expect(nonPr.slice(0, 200)).toContain('build_apk=true');
    });
});
