/**
 * desktop-release.yml builds macOS and Windows on a pull request only when the
 * PR changes how a package is made, carries the `desktop-full` label, or its
 * changed files cannot be listed. Every other PR is built and launched on
 * Linux only (the workflow's header has the measured cost behind that).
 *
 * The packaging-path list in its `plan` job is then the only thing between a
 * macOS- or Windows-only packaging regression and a green PR, and a list of
 * paths is exactly what goes stale when a file moves. So it is asserted here,
 * next to the files it names. desktop-checks.yml carries desktop-release.yml in
 * its paths so that an edit to the list runs this file.
 *
 * The right answer to a failure here is to ADD a pattern. Relaxing an assertion
 * gives back the safety that made the saving acceptable.
 *
 * No YAML dependency: the sentinel-fenced block and the `pick` step are read
 * as text, as mobile/src/lib/androidCiTrigger.test.ts reads android-release.yml.
 * It sits in src/main because `npm test` runs src/**\/*.test.ts and
 * tsconfig.json type-checks src/main; tsconfig.main.json keeps tests out of
 * the app.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

const WORKFLOW_PATH = '.github/workflows/desktop-release.yml';

/** The repository root: the first directory above the working one that holds the workflow. */
function findRepoRoot(): string {
    for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, WORKFLOW_PATH))) return dir;
        assert.notEqual(path.dirname(dir), dir, `no ${WORKFLOW_PATH} above ${process.cwd()}`);
    }
}

const REPO = findRepoRoot();
const DESKTOP = path.join(REPO, 'desktop');
const workflow = fs.readFileSync(path.join(REPO, WORKFLOW_PATH), 'utf8');

/**
 * The lines between the sentinels, exactly as grep reads them. An empty or
 * unreadable block must FAIL here, not make every assertion below vacuous.
 */
function fencedLines(): string[] {
    const begin = workflow.indexOf('# PACKAGING_PATHS_BEGIN');
    const end = workflow.indexOf('# PACKAGING_PATHS_END');
    assert.ok(begin > -1 && end > begin, 'the PACKAGING_PATHS sentinels are missing or out of order');
    // Drop the BEGIN line and the indentation in front of END; a blank line in
    // between stays, so the first test below can refuse it.
    return workflow
        .slice(begin, end)
        .split('\n')
        .slice(1, -1)
        .map((line) => line.trim());
}

const PATTERNS = fencedLines()
    .filter((line) => line !== '')
    .map((line) => new RegExp(line));
const coveredBy = (file: string) => PATTERNS.some((p) => p.test(file));

/**
 * Build outputs rather than inputs: the compiled app (dist/, the same on every
 * platform and launched by every Linux leg) and electron-builder's own output
 * (release/). A local build leaves both behind.
 */
const OUTPUT_DIRS = new Set(['node_modules', 'dist', 'release', 'e2e-results', 'e2e-report']);

/** Every file under `dir`, as a repo-relative POSIX path, outputs skipped. */
function filesUnder(dir: string): string[] {
    const found: string[] = [];
    const pending = [dir];
    while (pending.length > 0) {
        const current = pending.pop() as string;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (!OUTPUT_DIRS.has(entry.name)) pending.push(path.join(current, entry.name));
            } else {
                found.push(path.relative(REPO, path.join(current, entry.name)).split(path.sep).join('/'));
            }
        }
    }
    return found;
}

/**
 * Every existing file or directory electron-builder.yml names as a single-token
 * value (`icon: build/icon.png`, `- from: build/linux/beeflow.sh`,
 * `- resources/**\/*`), as a desktop-relative path. Free text never matches:
 * only `key: value` and `- value` lines with one token are read.
 */
function builderInputs(): string[] {
    const text = fs.readFileSync(path.join(DESKTOP, 'electron-builder.yml'), 'utf8');
    const inputs = new Set<string>();
    for (const line of text.split('\n')) {
        const m = /^\s*(?:-\s+)?(?:[A-Za-z][\w.-]*:\s+)?(['"]?)([^\s'"#]+)\1\s*(?:#.*)?$/.exec(line);
        const token = m?.[2];
        if (!token || token.startsWith('!') || token.startsWith('/') || token.includes('${')) continue;
        const stem = token.split('*')[0]!.replace(/\/+$/, '');
        if (!stem || OUTPUT_DIRS.has(stem.split('/')[0]!)) continue;
        if (fs.existsSync(path.join(DESKTOP, stem))) inputs.add(stem);
    }
    return [...inputs].sort();
}

describe('desktop-release.yml packaging-path list', () => {
    it('is read by the test exactly as grep reads it', () => {
        // A blank line in a `grep -f` file matches every path, which would make
        // every PR build every platform again, silently. And a pattern outside
        // this plain subset could mean one thing to `grep -E` and another here.
        const lines = fencedLines();
        assert.ok(lines.length >= 5, `only ${lines.length} patterns between the sentinels`);
        for (const line of lines) {
            assert.match(line, /^\^[A-Za-z0-9_./\\-]+\$?$/, `not a plain anchored path pattern: ${JSON.stringify(line)}`);
        }
    });

    it('covers every file that shapes a package today', () => {
        // Named, not counted: each of these, changed alone, must still build
        // macOS and Windows on the PR.
        const mustBuildAll = [
            'desktop/electron-builder.yml',
            'desktop/package.json',
            'desktop/package-lock.json',
            'desktop/build/entitlements.mac.plist',
            'desktop/build/entitlements.mac.inherit.plist',
            'desktop/build/installer.nsh',
            'desktop/build/icon.png',
            'desktop/resources/trayTemplate.png',
            '.nvmrc',
            WORKFLOW_PATH,
        ];
        assert.deepEqual(
            mustBuildAll.filter((f) => !coveredBy(f)),
            [],
        );
    });

    it('keeps the skip that pays for it', () => {
        // THE anti-regression for the saving: re-add a broad `^desktop/` and
        // this is what catches it. Source with a platform branch (menu.ts) is
        // on purpose here too; the header says why and what the label is for.
        const mustStayLinux = [
            'desktop/src/main/app.ts',
            'desktop/src/main/menu.ts',
            'desktop/src/preload/index.ts',
            'desktop/src/shell/settings.ts',
            'desktop/e2e/connect.spec.ts',
            'desktop/scripts/build-preload.mjs',
            'desktop/tsconfig.json',
            'desktop/README.md',
            '.github/workflows/desktop-checks.yml',
        ];
        assert.deepEqual(
            mustStayLinux.filter((f) => coveredBy(f)),
            [],
        );
    });

    it('has no dead pattern', () => {
        // The rename detector: move build/ or resources/ and its pattern would
        // silently stop protecting anything.
        const candidates = [...filesUnder(DESKTOP), '.nvmrc', ...fs.readdirSync(path.join(REPO, '.github/workflows')).map((f) => `.github/workflows/${f}`)];
        assert.ok(candidates.length > 20, 'found almost no files to test the patterns against');
        assert.deepEqual(
            PATTERNS.filter((p) => !candidates.some((f) => p.test(f))).map((p) => p.source),
            [],
        );
    });

    it('covers every file electron-builder.yml packages from outside the compiled app', () => {
        // A new `extraFiles`, a DMG background, a second NSIS include: whatever
        // the config starts reading, a change to it has to build every platform.
        const inputs = builderInputs();
        assert.ok(inputs.includes('build/icon.png') && inputs.includes('resources'), `the config scan found only: ${inputs.join(', ')}`);
        const uncovered = inputs.flatMap((input) => {
            const full = path.join(DESKTOP, input);
            const files = fs.statSync(full).isDirectory() ? filesUnder(full) : [`desktop/${input}`];
            return files.filter((f) => !coveredBy(f));
        });
        assert.deepEqual(uncovered, []);
    });

    it('covers native code wherever it lands', () => {
        // None today: chokidar 4 and electron-updater are plain JavaScript. A
        // native module would arrive through package.json (covered); code of
        // our own that needs a compiler would not, and fails here until listed.
        const nativeish = filesUnder(DESKTOP).filter((f) => /(^|\/)binding\.gyp$|CMakeLists\.txt$|\.(c|cc|cpp|h|m|mm|node|rs)$/.test(f));
        assert.deepEqual(
            nativeish.filter((f) => !coveredBy(f)),
            [],
        );
    });

    it('keeps the label escape hatch and the release fence wired', () => {
        // Lose any of these and the label is a no-op, a narrowed run can
        // publish, or the coverage report stops saying what was skipped.
        for (const needle of [
            'types: [opened, synchronize, reopened, labeled]',
            "contains(github.event.pull_request.labels.*.name, 'desktop-full')",
            "needs.plan.outputs.platforms == 'all'",
            'platforms: ${{ steps.pick.outputs.platforms }}',
            'WHY: ${{ needs.plan.outputs.why }}',
        ]) {
            assert.ok(workflow.includes(needle), `desktop-release.yml no longer contains: ${needle}`);
        }
    });
});

/** One job's text: from its `  <name>:` line up to the next job. */
function jobText(name: string): string {
    const lines = workflow.split('\n');
    const start = lines.indexOf(`  ${name}:`);
    assert.ok(start > -1, `no job \`${name}\` in desktop-release.yml`);
    const end = lines.findIndex((l, i) => i > start && /^ {2}[A-Za-z][\w-]*:\s*$/.test(l));
    return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

/**
 * The repository is public: pull requests come from forks, and the workflow a
 * same-repository branch carries is the one that runs. These are the fences
 * the header describes, as tripwires against an edit that drops one.
 */
describe('desktop-release.yml public-repository fences', () => {
    it('lets the signing secrets reach a build only from main', () => {
        const build = jobText('build');
        assert.ok(
            build.includes("SIGNING_ALLOWED: ${{ github.event_name != 'pull_request' && github.ref == 'refs/heads/main' }}"),
            'the build job no longer derives SIGNING_ALLOWED from "not a pull request, and main"',
        );
        const reads = build.split('\n').filter((l) => l.includes('secrets.') && !l.trim().startsWith('#'));
        assert.ok(reads.length > 0, 'found no secret in the build job to check');
        assert.deepEqual(
            reads.filter((l) => !l.includes("${{ env.SIGNING_ALLOWED == 'true' && ") || !l.trimEnd().endsWith("|| '' }}")),
            [],
        );
    });

    it('uploads and launches nothing from a fork', () => {
        assert.ok(
            workflow.includes("fork: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository }}"),
            'the plan job no longer derives its fork output',
        );
        const build = jobText('build').split('\n');
        const uploadGates = build.flatMap((l, i) => (l.includes('uses: actions/upload-artifact@') ? [build[i - 1]!.trim()] : []));
        assert.deepEqual(uploadGates, ["if: ${{ needs.plan.outputs.fork == 'false' }}"]);
        for (const job of ['launch', 'launch-linux-arm64', 'launch-windows-arm64']) {
            const gate = jobText(job).split('\n').find((l) => /^ {4}if: /.test(l)) ?? '';
            assert.match(gate, /needs\.plan\.outputs\.fork == 'false'/, `${job} can run for a fork`);
        }
    });

    it('never lets a variable pick a runner, and keeps the arm64 legs opt-in', () => {
        assert.deepEqual(
            workflow.split('\n').filter((l) => /^\s*runs-on:.*vars\./.test(l)),
            [],
        );
        for (const job of ['launch-linux-arm64', 'launch-windows-arm64']) {
            assert.match(jobText(job), /^ {4}if: .*vars\.DESKTOP_ARM64_BUILDS == 'true'/m, `${job} is no longer opt-in`);
        }
    });

    it('publishes only from main', () => {
        assert.match(jobText('release'), /^\s+&& github\.ref == 'refs\/heads\/main'$/m);
    });
});

/**
 * The `run:` script of the `pick` step, dedented. It has to be runnable
 * outside Actions, so an expression spliced into it fails here.
 */
function pickScript(): string {
    const lines = workflow.split('\n');
    const step = lines.findIndex((l) => /^\s+- id: pick$/.test(l));
    assert.ok(step > -1, 'no `- id: pick` step in desktop-release.yml');
    const run = lines.findIndex((l, i) => i > step && /^\s+run: \|$/.test(l));
    assert.ok(run > -1, 'the pick step has no `run: |` block');
    const body: string[] = [];
    let indent = -1;
    for (const line of lines.slice(run + 1)) {
        if (line.trim() === '') {
            body.push('');
            continue;
        }
        const own = line.length - line.trimStart().length;
        if (indent === -1) indent = own;
        if (own < indent) break;
        body.push(line.slice(indent));
    }
    const script = body.join('\n');
    assert.ok(!script.includes('${{'), 'the pick script splices a ${{ }} expression; pass it through env instead');
    return script;
}

interface PlanInput {
    event: 'pull_request' | 'push' | 'workflow_dispatch';
    platforms?: string;
    labelled?: boolean;
    /** The PR's files as the REST API lists them; absent means the call fails. */
    files?: Array<{ filename: string; previous_filename?: string }>;
    /** Put a `grep` that exits 2 (an error, not "no match") first on the PATH. */
    grepBroken?: boolean;
}

interface PlanResult {
    outputs: Record<string, string>;
    ghCalls: string[];
    stdout: string;
}

/** Run the real `pick` script with a stand-in `gh` that serves `files` through the script's own --jq. */
function runPlan(input: PlanInput): PlanResult {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beeflow-desktop-plan-'));
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(tmp, 'files.json'), JSON.stringify(input.files ?? []));
    fs.writeFileSync(
        path.join(bin, 'gh'),
        [
            '#!/usr/bin/env bash',
            'echo "$*" >> "$STUB_CALLS"',
            '[[ -n "${STUB_FAIL:-}" ]] && { echo "gh: HTTP 502" >&2; exit 1; }',
            'while [[ $# -gt 0 ]]; do [[ "$1" == --jq ]] && JQ="$2"; shift; done',
            'jq -r "$JQ" "$STUB_FILES"',
            '',
        ].join('\n'),
        { mode: 0o755 },
    );
    if (input.grepBroken) {
        fs.writeFileSync(path.join(bin, 'grep'), '#!/usr/bin/env bash\necho "grep: broken" >&2\nexit 2\n', { mode: 0o755 });
    }
    const script = path.join(tmp, 'pick.sh');
    fs.writeFileSync(script, pickScript());
    const calls = path.join(tmp, 'calls');
    const output = path.join(tmp, 'output');
    fs.writeFileSync(calls, '');
    fs.writeFileSync(output, '');
    const result = spawnSync('bash', [script], {
        encoding: 'utf8',
        env: {
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
            RUNNER_TEMP: tmp,
            GITHUB_OUTPUT: output,
            GH_TOKEN: 'not-a-token',
            EVENT: input.event,
            WANTED: input.event === 'workflow_dispatch' ? (input.platforms ?? 'all') : 'all',
            LABELLED: String(input.event === 'pull_request' && input.labelled === true),
            PR_NUMBER: input.event === 'pull_request' ? '42' : '',
            REPO: 'Bee-Flow/Bee-Flow-AI',
            STUB_FILES: path.join(tmp, 'files.json'),
            STUB_CALLS: calls,
            ...(input.files === undefined ? { STUB_FAIL: '1' } : {}),
        },
    });
    assert.equal(result.status, 0, `the pick script failed:\n${result.stdout}\n${result.stderr}`);
    const outputs: Record<string, string> = {};
    for (const line of fs.readFileSync(output, 'utf8').split('\n').filter(Boolean)) {
        const eq = line.indexOf('=');
        const key = line.slice(0, eq);
        assert.ok(!(key in outputs), `output ${key} written twice`);
        outputs[key] = line.slice(eq + 1);
    }
    const ghCalls = fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean);
    fs.rmSync(tmp, { recursive: true, force: true });
    return { outputs, ghCalls, stdout: result.stdout };
}

const platformsOf = (r: PlanResult) => (JSON.parse(r.outputs.matrix ?? '[]') as Array<{ platform: string }>).map((m) => m.platform);
const legsOf = (r: PlanResult) => (JSON.parse(r.outputs.launch ?? '[]') as Array<{ leg: string }>).map((m) => m.leg);
const EVERY_LEG = ['deb', 'appimage', 'targz', 'rpm', 'pacman', 'nsis', 'portable-zip', 'dmg', 'dmg-intel'];
const LINUX_LEGS = ['deb', 'appimage', 'targz', 'rpm', 'pacman'];

// bash and jq are on every CI runner; a Windows checkout usually lacks one of
// them, and a missing tool there says nothing about the workflow. On CI a
// missing tool is a failure, never a skip.
const noShell =
    process.env.CI === undefined &&
    (process.platform === 'win32' || spawnSync('bash', ['-c', 'command -v jq']).status !== 0) &&
    'needs bash and jq';

describe('desktop-release.yml plan, run for real', { skip: noShell }, () => {
    it('builds and launches everything on a push to main, without asking GitHub', () => {
        const r = runPlan({ event: 'push' });
        assert.equal(r.outputs.platforms, 'all');
        assert.deepEqual(platformsOf(r), ['linux', 'macos', 'windows']);
        assert.deepEqual(legsOf(r), EVERY_LEG);
        assert.equal(r.outputs.linux, 'true');
        assert.equal(r.outputs.windows, 'true');
        assert.deepEqual(r.ghCalls, []);
    });

    it('builds what a manual run names, and only that', () => {
        const all = runPlan({ event: 'workflow_dispatch', platforms: 'all' });
        assert.equal(all.outputs.platforms, 'all');
        assert.deepEqual(legsOf(all), EVERY_LEG);
        const mac = runPlan({ event: 'workflow_dispatch', platforms: 'macos' });
        assert.equal(mac.outputs.platforms, 'macos');
        assert.deepEqual(platformsOf(mac), ['macos']);
        assert.deepEqual(legsOf(mac), ['dmg', 'dmg-intel']);
        assert.equal(mac.outputs.linux, 'false');
        assert.deepEqual(mac.ghCalls, []);
    });

    it('builds Linux only for a PR that changes no packaging', () => {
        const r = runPlan({
            event: 'pull_request',
            files: [{ filename: 'desktop/src/main/menu.ts' }, { filename: 'desktop/e2e/connect.spec.ts' }, { filename: '.github/workflows/desktop-checks.yml' }],
        });
        assert.equal(r.outputs.platforms, 'linux');
        assert.deepEqual(platformsOf(r), ['linux']);
        assert.deepEqual(legsOf(r), LINUX_LEGS);
        assert.equal(r.outputs.linux, 'true');
        assert.equal(r.outputs.windows, 'false');
        assert.match(r.outputs.why ?? '', /desktop-full/);
        assert.equal(r.ghCalls.length, 1);
        assert.match(r.ghCalls[0]!, /^api repos\/Bee-Flow\/Bee-Flow-AI\/pulls\/42\/files --paginate --jq /);
    });

    it('builds everything for a PR that changes packaging, and names the file', () => {
        const r = runPlan({ event: 'pull_request', files: [{ filename: 'desktop/src/main/app.ts' }, { filename: 'desktop/electron-builder.yml' }] });
        assert.equal(r.outputs.platforms, 'all');
        assert.deepEqual(legsOf(r), EVERY_LEG);
        assert.match(r.outputs.why ?? '', /desktop\/electron-builder\.yml/);
    });

    it('counts a packaging file under the name it was moved away from', () => {
        const r = runPlan({ event: 'pull_request', files: [{ filename: 'desktop/assets/icon.png', previous_filename: 'desktop/build/icon.png' }] });
        assert.equal(r.outputs.platforms, 'all');
    });

    it('builds everything for a labelled PR, without asking GitHub', () => {
        const r = runPlan({ event: 'pull_request', labelled: true, files: [{ filename: 'desktop/src/main/app.ts' }] });
        assert.equal(r.outputs.platforms, 'all');
        assert.deepEqual(r.ghCalls, []);
    });

    it('fails open when the changed files cannot be listed', () => {
        const r = runPlan({ event: 'pull_request' });
        assert.equal(r.outputs.platforms, 'all');
        assert.deepEqual(legsOf(r), EVERY_LEG);
        assert.match(r.stdout, /::warning::/);
    });

    it('fails open when the path check itself errors, rather than reading it as "no match"', () => {
        const r = runPlan({ event: 'pull_request', grepBroken: true, files: [{ filename: 'desktop/src/main/app.ts' }] });
        assert.equal(r.outputs.platforms, 'all');
        assert.match(r.stdout, /::warning::.*grep exit 2/);
    });
});
