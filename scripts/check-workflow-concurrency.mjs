#!/usr/bin/env node
/**
 * Concurrency policy for .github/workflows/.
 *
 * Cancelling a superseded run is free money on a check suite and a data-loss
 * bug on a publish or a deploy. The difference is not visible from the YAML —
 * it is a property of what the job DOES — so it is written down here, per file,
 * with the reason, and asserted on every PR that touches a workflow.
 *
 * Every file in the directory must be in exactly one bucket. An unclassified
 * file is a FAILURE: a new deploy workflow cannot be added without someone
 * deciding whether it may be cancelled midway.
 *
 * PARSING: column-0 line scanning, zero dependencies. Root package.json has
 * only `concurrently` and `jscpd` and the root tree has no node_modules
 * installed, so this must import nothing outside node:*. Do not add a YAML
 * dependency and do not write a YAML parser — instead, if the shape assumption
 * ever breaks, this exits 1 and says so (see the tripwire at the bottom).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = path.join(ROOT, '.github/workflows');

const MUST_NOT_CANCEL = {
    'promote-release.yml': 'production tag promotion must finish without leaving a partly promoted release',
    'release-latest.yml': 'cancelling between crane tag calls leaves :latest split across two releases',
    'staging-release-validation.yml': 'staging acceptance is durable evidence for a specific release candidate and must retain its verdict',
    'build-push-ghcr.yml':
        'cancelling mid-push leaves a half-written multi-arch manifest and can move the :dev tags to an image that was never finished',
    'release-dockerhub.yml': 'cancelling can leave Docker Hub :latest moved to an image whose push never completed',
    'connector-release.yml':
        'cancelling can leave the connector mirror and the Nextcloud App Store submission disagreeing about what shipped',
};

const CONDITIONAL_CANCEL = {
    'android-release.yml':
        'dev builds supersede, prod builds never do — a signed release build that is cancelled halfway produces no artefact and a tag that points at nothing',
    'ci.yml':
        'PR runs supersede; every other run (a push to main through build-push-ghcr.yml, a manual run) keeps its verdict, because that verdict is what you bisect with',
    'desktop-checks.yml':
        'PR runs supersede; push-to-main runs must keep their verdict, same reason as ci.yml',
    'desktop-release.yml':
        'PR builds supersede; a publishing run never does — cancelled between `gh release delete` and the upload, it leaves desktop-dev with no release at all',
};

const NO_CONCURRENCY = {
    'a11y-conformance.yml':
        'workflow_call reusable workflow: a shared group lets one caller cancel another caller\'s job and fail the parent run',
    'e2e-smoke.yml':
        'workflow_call reusable workflow: a shared group lets one caller cancel another caller\'s job and fail the parent run',
};

const NO_POLICY = {
    'dependency-audit.yml': '94 s, 0 supersedes in 138 runs — nothing to save, and it produces a REQUIRED context',
    'image-scan.yml': 'schedule-only, never races with itself',
    'nextcloud-regression.yml': 'workflow_dispatch only',
    'sast.yml': 'PR-only and not a required context: a superseded run costs minutes, and nothing waits on it',
    'secret-scan.yml':
        '23 s, 0 supersedes in 138 runs — nothing to save, and it produces the REQUIRED `scan` context, so leaving it alone sidesteps the non-unique-context hazard entirely',
    'workflow-policy.yml': 'the gate itself; ~15 s',
};

const BUCKETS = [
    ['MUST_NOT_CANCEL', MUST_NOT_CANCEL],
    ['CONDITIONAL_CANCEL', CONDITIONAL_CANCEL],
    ['NO_CONCURRENCY', NO_CONCURRENCY],
    ['NO_POLICY', NO_POLICY],
];

const violations = [];
const fail = (msg) => violations.push(msg);

/**
 * The top-level `concurrency:` block, read as raw text: from a column-0
 * `concurrency:` to the next column-0 key.
 */
function readConcurrency(file, text) {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => /^concurrency:/.test(l));

    // Tripwire: a job-level concurrency key would be invisible to this scanner.
    const indented = lines.findIndex((l, i) => i !== start && /^\s+concurrency:/.test(l));
    if (indented !== -1) {
        fail(
            `${file}: this script reads top-level concurrency blocks by column-0 scanning and that assumption no longer holds for ${file} ` +
                `(job-level \`concurrency:\` on line ${indented + 1})`,
        );
        return null;
    }
    if (start === -1) return { present: false };

    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
        if (/^[A-Za-z0-9_'"-]+:/.test(lines[i])) {
            end = i;
            break;
        }
    }
    const body = lines.slice(start + 1, end);
    const groupAt = body.findIndex((l) => /^\s{2}group:/.test(l));
    const cancelAt = body.findIndex((l) => /^\s{2}cancel-in-progress:/.test(l));
    if (groupAt === -1 || cancelAt === -1) {
        fail(
            `${file}: this script reads top-level concurrency blocks by column-0 scanning and that assumption no longer holds for ${file} ` +
                '(the block yielded no `group:` and/or no `cancel-in-progress:` line)',
        );
        return null;
    }
    // group: may be a folded scalar, so take everything up to the next 2-space key.
    let groupEnd = body.length;
    for (let i = groupAt + 1; i < body.length; i += 1) {
        if (/^\s{2}[A-Za-z0-9_-]+:/.test(body[i])) {
            groupEnd = i;
            break;
        }
    }
    return {
        present: true,
        group: body.slice(groupAt, groupEnd).join(' '),
        cancel: body[cancelAt].replace(/^\s*cancel-in-progress:\s*/, '').trim(),
    };
}

/**
 * The literal name-fragments a `group:` line can claim.
 *
 * Only the parts that end up IN the group name count, so quoted strings that
 * are comparison operands (`github.event_name == 'workflow_dispatch'`) are
 * skipped — they steer the choice, they are not the name. A `format()`
 * placeholder is where the varying part starts, so everything from the first
 * `{` on is dropped: `format('ghcr-{0}-{1}', …)` claims `ghcr-`.
 */
function groupNameLiterals(groupLine) {
    const out = new Set();
    const add = (v) => {
        // `${{` first: splitting on a bare `{` would turn `${{ … }}` into `$`.
        const lit = v.split('${{')[0].split('{')[0];
        if (lit) out.add(lit);
    };
    for (const m of groupLine.matchAll(/'([^']*)'/g)) {
        const before = groupLine.slice(0, m.index).trimEnd();
        if (/[=!]=$/.test(before)) continue; // a comparison operand, not a name
        add(m[1]);
    }
    // A bare (unquoted) scalar group: `group: connector-release`, `group: mobile-checks-${{ … }}`.
    const bare = /^\s*group:\s*([^'">|\s].*)$/.exec(groupLine);
    if (bare) add(bare[1].trim());
    return out;
}

if (!fs.existsSync(WORKFLOWS)) {
    console.error(`workflow-concurrency: ${path.relative(ROOT, WORKFLOWS)} does not exist`);
    process.exit(1);
}

const files = fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort();
const rows = [];
const groupLiterals = new Map();

for (const file of files) {
    const buckets = BUCKETS.filter(([, table]) => file in table).map(([name]) => name);
    if (buckets.length === 0) {
        fail(
            `${file}: in no bucket. Decide whether this workflow may be cancelled midway and add it to one of ` +
                `${BUCKETS.map(([n]) => n).join(', ')} in scripts/check-workflow-concurrency.mjs, with a reason.`,
        );
        continue;
    }
    if (buckets.length > 1) {
        fail(`${file}: in ${buckets.length} buckets (${buckets.join(', ')}) — it must be in exactly one.`);
        continue;
    }
    const [bucket] = buckets;
    const reason = BUCKETS.find(([n]) => n === bucket)[1][file];
    const c = readConcurrency(file, fs.readFileSync(path.join(WORKFLOWS, file), 'utf8'));
    if (c === null) continue; // tripwire already reported

    if (bucket === 'NO_CONCURRENCY') {
        if (c.present) fail(`${file} [NO_CONCURRENCY]: has a top-level concurrency: block — ${reason}`);
    } else if (bucket === 'MUST_NOT_CANCEL') {
        if (!c.present) fail(`${file} [MUST_NOT_CANCEL]: no concurrency: block — ${reason}`);
        else if (c.cancel !== 'false') {
            fail(`${file} [MUST_NOT_CANCEL]: cancel-in-progress is \`${c.cancel}\`, must be the literal \`false\` — ${reason}`);
        }
    } else if (bucket === 'CONDITIONAL_CANCEL') {
        if (!c.present) fail(`${file} [CONDITIONAL_CANCEL]: no concurrency: block — ${reason}`);
        else if (!/^\$\{\{.*\}\}$/.test(c.cancel)) {
            fail(
                `${file} [CONDITIONAL_CANCEL]: cancel-in-progress is \`${c.cancel}\`, must be a \${{ … }} expression and never the bare literal \`true\` — ${reason}`,
            );
        } else if (file === 'android-release.yml' && !c.cancel.includes("'prod'")) {
            fail(`${file} [CONDITIONAL_CANCEL]: the cancel expression no longer excludes 'prod' — ${reason}`);
        }
    }

    if (c.present) {
        for (const lit of groupNameLiterals(c.group)) {
            const owner = groupLiterals.get(lit);
            if (owner && owner !== file) {
                fail(
                    `${file} and ${owner} both claim the concurrency group literal '${lit}'. Required-check contexts are matched by ` +
                        'a non-unique name and so are concurrency groups: a shared literal lets one workflow cancel the other.',
                );
            } else {
                groupLiterals.set(lit, file);
            }
        }
    }
    rows.push({ file, bucket, cancel: c.present ? c.cancel : '(none)' });
}

if (violations.length > 0) {
    for (const v of violations) console.error(`workflow-concurrency: ${v}`);
    process.exit(1);
}

const w = Math.max(...rows.map((r) => r.file.length));
for (const r of rows) console.log(`${r.file.padEnd(w)}  ${r.bucket.padEnd(19)}  cancel-in-progress: ${r.cancel}`);
console.log(`workflow-concurrency: ${rows.length} workflows, each in exactly one bucket`);
