#!/usr/bin/env node
/**
 * The contexts that gate a merge must each be produced by exactly one job.
 *
 * Repo ruleset 23605458 requires the status-check contexts listed in
 * .github/required-checks.json. GitHub matches a required context BY NAME, and
 * a name is not unique in this repository: `scan` was the job id of both
 * secret-scan.yml (which produces the required context) and image-scan.yml
 * (which does not, today, only because it is a matrix and therefore emits
 * `scan (server)`, `scan (guard)`, … instead of a bare `scan`). Collapse that
 * matrix to one image and image-scan.yml starts satisfying a required check
 * from a job that sets exit-code: '0' and fail-fast: false — a permanently
 * green gate. The ruleset's integration_id: 15368 is no defence: both
 * workflows are GitHub Actions, i.e. both ARE app 15368.
 *
 * So this asserts, for every required context C:
 *   R1  exactly one non-matrix job in the tree emits C
 *   R2  C is not emitted only by a matrix job
 *   R3  that job's workflow has a pull_request trigger
 *   R4  that trigger carries no paths:/paths-ignore: filter
 *   R5  that job has no top-level if: — except `always()`, the one condition an
 *       aggregate job needs in order to report when a dependency failed
 *   R7  no other job anywhere uses C as its job id
 *   R8  when that job is an aggregate (`if: always()`), its needs: lists every
 *       other job in its workflow. ci.yml's checks-passed is green when every
 *       job it NEEDS succeeded or was skipped; a job added to ci.yml but not to
 *       that list runs, fails, and blocks nothing.
 *   R9  a job whose name: is a two-way expression (below) has two different
 *       branches, and at most one of them is a required context
 *
 * TWO-WAY NAMES. A job's name: may be exactly one whole-value expression
 *     ${{ <condition> && '<A>' || '<B>' }}
 * and such a job emits A when the condition holds and B when it does not. It
 * exists for ci.yml's aggregate on a draft PR, which skips the long suites: a
 * draft run must never emit the required name. Otherwise, once the PR is
 * marked ready, the draft run's green checks-passed on the same head SHA
 * satisfies the ruleset before the full run has reported, because a job still
 * waiting on its needs: has no check run yet. So checks-passed calls itself
 * 'checks-passed (draft)' on a draft. The condition decides only WHICH name,
 * never WHETHER the job reports: R5 still demands the job run on every event.
 * It counts as a producer of C when A or B is C (once, for R1), and R2-R8
 * apply to it unchanged. The grammar is deliberately narrow: single-quoted,
 * non-empty literals (a non-empty string is truthy, so `&& ||` cannot fall
 * through to B), and a condition with no && or || outside parentheses (in
 * `a || b && 'A' || 'B'` the name can be the value of `a`). Any other name
 * that starts with `${{` and ends with `}}` is Unparseable, as is a two-way
 * name on a matrix job; a name that merely CONTAINS an expression, such as a
 * matrix job's `Frontend tests (${{ matrix.shard }}/3)`, is read literally.
 *
 * SCOPE, STATED HONESTLY: this only sees the WORKING TREE. A workflow that
 * exists only on another branch is invisible here. A collision
 * introduced on another branch is caught when that branch's PR runs this
 * against its merge with main, which is the moment it matters. The ruleset
 * does not require that branch to be up to date with main (see
 * required-checks.json), so two PRs that each pass can still collide once
 * both have merged; secret-scan.yml's push run on main then reports it.
 *
 * PARSING: a narrow line scanner, not a YAML parser. No YAML package exists
 * anywhere in this monorepo and none is to be added; `node` is preinstalled on
 * ubuntu-latest, so this needs no setup-node and no npm ci. Every workflow in
 * the tree is column-0 top-level keys, 2-space job ids, 4-space job keys, no
 * tabs. Anything the scanner cannot classify is a FAILURE, never a silent skip:
 * widen the scanner rather than loosening it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = path.join(ROOT, '.github/workflows');
const CONFIG = path.join(ROOT, '.github/required-checks.json');

const violations = [];
const fail = (msg) => violations.push(msg);

/** A file the scanner refuses to guess about. Never downgrade this to a skip. */
class Unparseable extends Error {}

const TOP_KEY = /^([A-Za-z0-9_'"-]+):/;
const JOB_ID = /^ {2}([A-Za-z0-9_-]+):\s*$/;
const JOB_KEY = /^ {4}([A-Za-z0-9_-]+):(.*)$/;
const IGNORABLE = /^\s*(#.*)?$/;
const ALWAYS = /^(\$\{\{\s*)?always\(\)(\s*\}\})?$/;
// `${{ <condition> && '<A>' || '<B>' }}`, the one whole-value expression a
// name: may be (see TWO-WAY NAMES). The literals hold no quote or brace.
const TWO_WAY = /^\$\{\{\s*(.+?)\s*&&\s*'([^'{}]+)'\s*\|\|\s*'([^'{}]+)'\s*\}\}$/;

/** A one-line `name:` value as YAML reads it: a plain scalar ends at ` #`, a quoted one at its closing quote. */
function nameScalar(jobId, raw) {
    const v = raw.trim();
    // A folded/literal scalar name is not something this scanner can resolve
    // to the string GitHub will display.
    if (v === '' || v.startsWith('>') || v.startsWith('|')) {
        throw new Unparseable(`job \`${jobId}\` has a multi-line \`name:\` the scanner cannot resolve`);
    }
    if (v.startsWith('"') || v.startsWith("'")) {
        const q = /^(["'])(.*?)\1\s*(#.*)?$/.exec(v);
        // Double-quoted escapes (`\"`, `\u…`) are not decoded here.
        if (!q || (q[1] === '"' && q[2].includes('\\'))) {
            throw new Unparseable(`job \`${jobId}\` has a quoted \`name:\` the scanner cannot resolve: ${v}`);
        }
        return q[1] === "'" ? q[2].replaceAll("''", "'") : q[2];
    }
    return v.replace(/\s+#.*$/, '');
}

/** True when `cond` has balanced parentheses and quotes and no && or || outside parentheses. */
function isSingleCondition(cond) {
    if (cond.includes('${{') || cond.includes('}}') || cond.includes('"')) return false;
    let depth = 0;
    let inString = false;
    for (let i = 0; i < cond.length; i += 1) {
        const c = cond[i];
        // An escaped '' closes and reopens the literal, which leaves the state right.
        if (c === "'") {
            inString = !inString;
        } else if (inString) {
            continue;
        } else if (c === '(') {
            depth += 1;
        } else if (c === ')') {
            depth -= 1;
            if (depth < 0) return false;
        } else if (depth === 0 && (cond.startsWith('&&', i) || cond.startsWith('||', i))) {
            return false;
        }
    }
    return !inString && depth === 0;
}

/** The condition and the two names of a two-way `name:`, or Unparseable. */
function twoWayName(jobId, value) {
    const m = TWO_WAY.exec(value);
    if (!m || !isSingleCondition(m[1])) {
        throw new Unparseable(
            `job \`${jobId}\` has a \`name:\` expression the scanner cannot resolve: ${value} — ` +
                "the one whole-value form it reads is ${{ <condition> && '<A>' || '<B>' }}",
        );
    }
    return { condition: m[1], branches: [m[2], m[3]] };
}

function parseWorkflow(file, text) {
    if (text.includes('\t')) {
        throw new Unparseable('it contains a tab; the scanner assumes space indentation only');
    }
    const lines = text.split('\n');

    // --- top-level key spans -------------------------------------------------
    const spans = [];
    lines.forEach((line, i) => {
        if (IGNORABLE.test(line)) return;
        const m = TOP_KEY.exec(line);
        if (m) spans.push({ key: m[1].replace(/^['"]|['"]$/g, ''), start: i, rest: line.slice(m[0].length) });
    });
    for (let i = 0; i < spans.length; i += 1) {
        spans[i].end = i + 1 < spans.length ? spans[i + 1].start : lines.length;
    }

    const onSpan = spans.find((s) => s.key === 'on');
    const jobsSpan = spans.find((s) => s.key === 'jobs');
    if (!onSpan) throw new Unparseable('no top-level `on:` key');
    if (!jobsSpan) throw new Unparseable('no top-level `jobs:` key');
    if (onSpan.rest.trim() !== '') {
        throw new Unparseable('`on:` uses the inline flow form (e.g. `on: [pull_request]`); the scanner only reads the block form');
    }
    if (jobsSpan.rest.trim() !== '') {
        throw new Unparseable('`jobs:` uses the inline flow form; the scanner only reads the block form');
    }

    // --- on: triggers --------------------------------------------------------
    let hasPullRequest = false;
    let pullRequestFiltered = false;
    let inPullRequest = false;
    for (let i = onSpan.start + 1; i < onSpan.end; i += 1) {
        const line = lines[i];
        if (IGNORABLE.test(line)) continue;
        const trigger = /^ {2}([A-Za-z0-9_-]+):/.exec(line);
        if (trigger) {
            inPullRequest = trigger[1] === 'pull_request';
            if (inPullRequest) hasPullRequest = true;
            continue;
        }
        if (inPullRequest && /^ {4}(paths|paths-ignore):/.test(line)) pullRequestFiltered = true;
    }

    // --- jobs ----------------------------------------------------------------
    const jobs = [];
    let current = null;
    // Set while reading a block-form `needs:` list (`      - job`).
    let inNeedsBlock = false;
    for (let i = jobsSpan.start + 1; i < jobsSpan.end; i += 1) {
        const line = lines[i];
        if (IGNORABLE.test(line)) continue;
        const id = JOB_ID.exec(line);
        if (id) {
            current = {
                id: id[1],
                line: i + 1,
                displayName: null,
                twoWay: null,
                hasMatrix: false,
                hasIf: false,
                ifValue: null,
                needs: [],
            };
            jobs.push(current);
            inNeedsBlock = false;
            continue;
        }
        const key = JOB_KEY.exec(line);
        if (key) {
            if (!current) throw new Unparseable(`a 4-space key on line ${i + 1} before any job id`);
            inNeedsBlock = false;
            if (key[1] === 'needs') {
                const v = key[2].replace(/\s+#.*$/, '').trim();
                if (v === '') {
                    inNeedsBlock = true;
                } else if (v.startsWith('[')) {
                    if (!v.endsWith(']')) {
                        throw new Unparseable(`job \`${current.id}\` has a \`needs:\` list that spans lines; write it on one line or as a block list`);
                    }
                    current.needs = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
                } else {
                    current.needs = [v.replace(/^['"]|['"]$/g, '')];
                }
            }
            if (key[1] === 'name') {
                current.displayName = nameScalar(current.id, key[2]);
                if (current.displayName.startsWith('${{') && current.displayName.endsWith('}}')) {
                    current.twoWay = twoWayName(current.id, current.displayName);
                }
            }
            if (key[1] === 'strategy') current.hasMatrix = true;
            if (key[1] === 'if') {
                current.hasIf = true;
                current.ifValue = key[2].trim();
            }
            continue;
        }
        if (inNeedsBlock) {
            const item = /^ {6}-\s+(['"]?)([A-Za-z0-9_-]+)\1\s*(#.*)?$/.exec(line);
            if (!item) throw new Unparseable(`line ${i + 1} inside job \`${current.id}\`'s \`needs:\` list is not a job id: ${JSON.stringify(line)}`);
            current.needs.push(item[2]);
            continue;
        }
        // Deeper than a job key: step/matrix/block-scalar content. Not our business.
        if (/^ {6,}\S/.test(line)) continue;
        throw new Unparseable(`line ${i + 1} inside \`jobs:\` cannot be classified: ${JSON.stringify(line)}`);
    }
    if (jobs.length === 0) throw new Unparseable('`jobs:` block contains no job ids');
    // A matrix job whose name uses a matrix value gets no ` (…)` suffix, so a
    // two-way name there could emit a bare A or B. R2 cannot reason about that.
    const matrixTwoWay = jobs.find((j) => j.twoWay && j.hasMatrix);
    if (matrixTwoWay) {
        throw new Unparseable(`job \`${matrixTwoWay.id}\` is a matrix with a two-way \`name:\` expression`);
    }

    return { file, hasPullRequest, pullRequestFiltered, jobs };
}

// --- load ------------------------------------------------------------------
if (!fs.existsSync(CONFIG)) {
    console.error(`required-checks: ${path.relative(ROOT, CONFIG)} is missing — the checker has nothing to enforce`);
    process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const required = config.required_contexts;
if (!Array.isArray(required) || required.length === 0) {
    console.error('required-checks: required_contexts is empty — refusing to pass vacuously');
    process.exit(1);
}

if (!fs.existsSync(WORKFLOWS)) {
    console.error(`required-checks: ${path.relative(ROOT, WORKFLOWS)} does not exist`);
    process.exit(1);
}

const workflows = [];
for (const name of fs.readdirSync(WORKFLOWS).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const rel = path.relative(ROOT, path.join(WORKFLOWS, name));
    try {
        workflows.push(parseWorkflow(rel, fs.readFileSync(path.join(WORKFLOWS, name), 'utf8')));
    } catch (e) {
        if (e instanceof Unparseable) {
            fail(`cannot parse ${rel}: ${e.message} — the checker is deliberately narrow; widen it rather than loosening it`);
            continue;
        }
        throw e;
    }
}

if (violations.length > 0) {
    for (const v of violations) console.error(`required-checks: ${v}`);
    process.exit(1);
}

// --- assert ----------------------------------------------------------------
// A matrix job emits `name (axis)`, never a bare `name`, so it is not a
// producer — but its bare id is still what R7 watches, because a later
// collapse of the matrix would turn it into one. A two-way name can emit
// either branch, so it is a candidate for both.
const emits = (job) => job.twoWay?.branches ?? [job.displayName ?? job.id];
const where = (wf, job) => `${wf.file}:${job.id}`;

// R9
for (const wf of workflows) {
    for (const job of wf.jobs) {
        if (!job.twoWay) continue;
        const [a, b] = job.twoWay.branches;
        if (a === b) {
            fail(`${where(wf, job)}: its two-way name: yields '${a}' on both branches; write it as a plain name`);
        } else if (required.includes(a) && required.includes(b)) {
            fail(
                `${where(wf, job)}: its two-way name: switches between two required contexts, '${a}' and '${b}'; ` +
                    'every run leaves one of them to another job or to nobody — ' +
                    'one branch must be a name the ruleset does not require',
            );
        }
    }
}

for (const context of required) {
    const producers = [];
    const matrixEmitters = [];
    const idCollisions = [];
    for (const wf of workflows) {
        for (const job of wf.jobs) {
            if (emits(job).includes(context)) (job.hasMatrix ? matrixEmitters : producers).push({ wf, job });
            if (job.id === context) idCollisions.push({ wf, job });
        }
    }

    if (producers.length === 0) {
        if (matrixEmitters.length > 0) {
            // R2
            const at = matrixEmitters.map(({ wf, job }) => where(wf, job)).join(', ');
            fail(`the job producing required context '${context}' is a matrix; it emits '${context} (…)' and never a bare '${context}' (${at})`);
        } else {
            // R1, zero producers
            fail(`no job emits required context '${context}' — the check will never report and every PR blocks`);
        }
        continue;
    }
    if (producers.length > 1) {
        // R1, duplicate producers. Reported, but NOT returned early: a context
        // emitted twice is usually also path-filtered (that is the `checks`
        // shape exactly), and a reader who fixes only the duplicate and pushes
        // deserves to have been told about the filter in the same run.
        const at = producers.map(({ wf, job }) => where(wf, job)).join(', ');
        fail(`required context '${context}' is emitted by ${producers.length} jobs: ${at}`);
    }

    for (const { wf, job } of producers) {
        // R3
        if (!wf.hasPullRequest) fail(`'${context}' is required but ${wf.file} has no pull_request trigger`);
        // R4
        if (wf.pullRequestFiltered) {
            fail(`'${context}' is required but ${wf.file} filters it by paths:; a PR that misses the filter blocks forever`);
        }
        // R5 — `always()` is the one condition allowed: an aggregate that
        // needs: every other job must still run when one of them fails, or it
        // is skipped and the required context never reports.
        if (job.hasIf && !ALWAYS.test(job.ifValue)) {
            fail(`the job producing required context '${context}' is conditional (${where(wf, job)} carries a top-level if: other than always())`);
        }
        // R8 — an aggregate only blocks on what it needs.
        if (job.hasIf && ALWAYS.test(job.ifValue)) {
            const unwatched = wf.jobs.filter((j) => j !== job && !job.needs.includes(j.id)).map((j) => j.id);
            if (unwatched.length > 0) {
                fail(
                    `required context '${context}' is an aggregate (${where(wf, job)}, if: always()) that does not need ` +
                        `${unwatched.join(', ')}; a failure there would block nothing — add ${unwatched.length === 1 ? 'it' : 'them'} to its needs:`,
                );
            }
        }
    }

    // R7
    const producing = producers.map(({ job }) => job);
    const producedBy = producers.map(({ wf }) => wf.file).join(', ') || '(nothing)';
    for (const c of idCollisions) {
        if (producing.includes(c.job)) continue;
        fail(`${c.wf.file}: job id '${context}' collides with required context '${context}' (produced by ${producedBy})`);
    }
}

if (violations.length > 0) {
    for (const v of violations) console.error(`required-checks: ${v}`);
    process.exit(1);
}

// Say which producers rename themselves, and when, so the log shows the
// two-way form was read rather than taken for a literal.
const renames = [];
for (const wf of workflows) {
    for (const job of wf.jobs) {
        if (!job.twoWay) continue;
        const [a, b] = job.twoWay.branches;
        if (required.includes(b)) renames.push(`${where(wf, job)} names itself '${a}' when ${job.twoWay.condition}`);
        else if (required.includes(a)) renames.push(`${where(wf, job)} names itself '${b}' unless ${job.twoWay.condition}`);
    }
}

console.log(
    `required-checks: ${required.length} contexts (${required.join(', ')}), ` +
        'each produced by exactly 1 non-matrix, unfiltered, PR-triggered job ' +
        '(unconditional, or an if: always() aggregate that needs every other job in its workflow)' +
        (renames.length > 0 ? `; ${renames.join('; ')}` : ''),
);
