#!/usr/bin/env node
// PreToolUse gate — restores the permission PROMPT for pushes to main/master,
// while every other branch pushes silently.
//
// Why a hook and not a permission rule: `permissions.allow` beats
// `permissions.ask`, so once `Bash(git push:*)` is allowed, a narrower
// `ask` rule for main can never fire underneath it. And `deny` would refuse
// the push outright rather than ask. A PreToolUse hook is the only place that
// can look at the actual command and answer "ask" for one branch and stay out
// of the way for the rest.
//
// FAILS CLOSED: when it cannot work out where a push is going it asks
// rather than guessing. A spurious prompt costs one click; a missed one
// pushes to main unannounced.
//
// It runs on EVERY Bash and PowerShell call: settings.json registers it
// under the Bash|PowerShell matcher with no `if` filter, so each call pays a
// node start (~50 ms) and a command in which `git` is not followed anywhere
// by `push` passes straight through after one regex. Two consequences:
// unreadable hook input asks for any command, not just a push; and text that
// merely contains `git push … main` (an echo, a commit message) gets a
// spurious prompt.
//
// The split below is deliberately cruder than lib/commands.mjs, which
// respects quotes. Splitting inside quotes as well is what catches
// `sh -c 'cd app; git push origin main; echo done'`: the quote-aware split
// sees one `sh` command there, and the push would go through unasked.
//
// That split still only knows a segment that reads `git push …`. Every other
// shape — `git -C . push origin main`, `(git push origin main)`,
// `bash -c "git push origin main"`, a quoted or `&`-suffixed refspec — gets a
// second, cruder look at the whole line before anything passes: main or
// master named anywhere on a line that pushes asks, and so does a push with no
// readable destination while main or master is checked out.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const PROTECTED = new Set(['main', 'master']);

// `git` with `push` somewhere after it: everything else passes on this one
// regex, without starting git.
const MAYBE_PUSH = /\bgit\b[\s\S]*\bpush\b/i;

function ask(reason) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: reason,
        },
    }));
    process.exit(0);
}

// Say nothing: no decision from this hook, so the normal permission rules
// apply and the push goes through silently.
function passThrough() {
    process.exit(0);
}

let input;
try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
    ask('Kon de hook-invoer niet lezen, dus de bestemming van deze push is onbekend.');
}

const command = String(input?.tool_input?.command || '');
if (!command) ask('Geen commando in de hook-invoer; bestemming van de push onbekend.');
if (!MAYBE_PUSH.test(command)) passThrough();

// A push can sit anywhere in a chained command ("npm test && git push
// ..."), so look at every git-push segment, not just the start of the
// string.
const pushSegments = command
    .split(/&&|\|\||;|\n/)
    .map(s => s.trim())
    .filter(s => /(^|\s)git\s+push(\s|$)/.test(s));

// Asked at most once: both looks below may need it.
let checkedOut;
const currentBranch = () => {
    if (checkedOut !== undefined) return checkedOut;
    try {
        checkedOut = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd: input?.cwd || process.cwd(),
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        checkedOut = null;   // unknown → caller asks
    }
    return checkedOut;
};

// A token as the shell hands it to git: `"main"`, `'main'` and the `main)`
// or `main&` this split leaves behind are all main.
const unquote = t => t.replace(/["']/g, '').replace(/[)&]+$/, '');

for (const segment of pushSegments) {
    // Everything after the `git push` verb, minus flags that take no value.
    const after = segment.replace(/^.*?\bgit\s+push\b/, '').trim();
    const tokens = after.split(/\s+/).map(unquote).filter(Boolean);

    // `--all` / `--mirror` push every branch, main included.
    if (tokens.some(t => t === '--all' || t === '--mirror')) {
        ask(`Deze push (${segment}) stuurt ÁLLE branches mee, dus ook main.`);
    }

    // Drop flags and their values to find the refspecs. `-u`/`--set-upstream`
    // take no value; `-o`/`--push-option` do.
    const refspecs = [];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === '-o' || t === '--push-option') { i++; continue; }
        if (t.startsWith('-')) continue;
        refspecs.push(t);
    }

    // First bare token is the remote; the rest are refspecs.
    const refs = refspecs.slice(1);

    if (refs.length === 0) {
        // A bare `git push` follows the checked-out branch (or push.default).
        const branch = currentBranch();
        if (branch === null) {
            ask(`Kon de huidige branch niet bepalen voor "${segment}".`);
        }
        if (PROTECTED.has(branch)) {
            ask(`"${segment}" pusht de huidige branch, en dat is ${branch}.`);
        }
        continue;
    }

    for (const ref of refs) {
        // A refspec is [+][src]:[dst]; the DESTINATION is what matters.
        const dst = (ref.includes(':') ? ref.split(':').pop() : ref)
            .replace(/^\+/, '')
            .replace(/^refs\/heads\//, '');
        if (PROTECTED.has(dst)) {
            ask(`"${segment}" pusht naar ${dst}.`);
        }
    }
}

// ── The second look ─────────────────────────────────────────────────────────
// The whole line without quotes and backticks, cut into words and the
// separators between commands. A redirection counts as a separator: its
// target is not a refspec.
const SEPARATOR = /^[;&|(){}<>\n]$/;
const words = command.replace(/["'`]/g, '').split(/([;&|(){}<>\n])|\s+/).filter(Boolean);

// A refspec's destination: after the last ':', without '+' and refs/heads/.
const destination = w => w.split(':').pop().replace(/^\+/, '').replace(/^refs\/heads\//, '');

const named = words.map(destination).find(d => PROTECTED.has(d));
if (named) {
    ask(`Dit commando lijkt te pushen en noemt ${named}; niet met zekerheid te lezen of de push daarheen gaat.`);
}

// Every `… git … push …` run of words: its remote and refspecs are the plain
// words after `push` up to the next separator.
const GIT = /(^|[\\/])git(\.exe)?$/i;
const PUSH_VALUE_OPTS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
let pushes = 0;
let followsBranch = false;
for (let k = 0; k < words.length; k++) {
    if (words[k] !== 'push') continue;
    let j = k - 1;
    while (j >= 0 && !SEPARATOR.test(words[j]) && !GIT.test(words[j])) j--;
    if (j < 0 || !GIT.test(words[j])) continue;
    pushes++;
    const plain = [];
    for (let m = k + 1; m < words.length && !SEPARATOR.test(words[m]); m++) {
        const t = words[m];
        if (PUSH_VALUE_OPTS.has(t)) m++;
        else if (t === '--all' || t === '--mirror' || t === '--branches') {
            ask('Deze push stuurt ÁLLE branches mee, dus ook main.');
        } else if (t.startsWith('-')) continue;
        // The 2 of 2>&1 is a file descriptor.
        else if (!(/^\d+$/.test(t) && /^[<>]$/.test(words[m + 1] ?? ''))) plain.push(t);
    }
    const refs = plain.slice(1);
    const unknown = refs.find(r => /[$*%]/.test(r));
    if (unknown) {
        ask(`Deze push noemt een bestemming die pas bij het uitvoeren bekend is (een variabele, $(…) of een patroon: ${unknown}).`);
    }
    // No refspec, or HEAD/@: the checked-out branch goes.
    if (refs.length === 0 || refs.some(r => /^(HEAD|@)$/.test(destination(r)))) followsBranch = true;
}

// A push with no readable destination, or a line that looks like a push but
// holds no push this could find, goes wherever the checkout is.
if (followsBranch || (pushes === 0 && pushSegments.length === 0)) {
    const current = currentBranch();
    if (current === null) ask('Kon de huidige branch niet bepalen voor dit push-commando.');
    if (PROTECTED.has(current)) ask(`Dit commando lijkt de huidige branch te pushen, en dat is ${current}.`);
}

passThrough();
