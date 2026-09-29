/**
 * Every Nextcloud executor call must pass the scope guard.
 *
 * The guard had exactly ONE call site — core/tools/toolDispatcher — and the
 * settings screen promised "Enforced on the server for chats, automations and
 * apps alike". Six other places reached a Nextcloud executor directly and were
 * therefore enforced nowhere: the Talk auto-record scan and its recording
 * write-back, the automation triggers for activity, notifications and calendar,
 * the Talk-meeting calendar sweep, and the recordings route's room listing. A
 * user who narrowed Talk to two conversations was still scanned across every
 * room they were in.
 *
 * Fixing those six is not what stops this recurring — the next background
 * feature would reintroduce it. This tripwire is: any file that calls a
 * Nextcloud family executor must also go through ncScopeGuard, and adding a
 * new call site fails here until it does.
 *
 * Deliberately exempt, each for a stated reason (see EXEMPT below). Adding to
 * that list is the explicit, reviewable act it should be.
 *
 * Run: cd server && node --test core/integrations/ncScopeGuard.callSites.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.resolve(__dirname, '..', '..');
const CALL_RE = /executeNextcloud[A-Za-z]*Tool\s*\(/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'coverage', 'dist', 'uploads']);

const EXEMPT = new Map([
    // The guard's home: it IS the check.
    ['core/tools/toolDispatcher.js', 'the single dispatcher the guard was written for'],
    // The picker behind "What Bee Flow may access" must show what you may ADD,
    // so it cannot be filtered by the selection it exists to edit. Documented
    // at the top of that route.
    ['routes/ncScope.js', 'lists selectable resources — filtering it by the current selection would make the selection unchangeable'],
]);

// Per CALL SITE, not per file.
//
// The first version of this test asked only whether the FILE mentioned
// guardedNcCall. ingestNextcloudRecording.js passed it while still fetching
// the Talk participant roster of an excluded room two functions below a
// guarded call — the roster is persisted into the meeting note as speaker
// names. A file-level check cannot see that, and "this file is compliant" is
// exactly the wrong granularity for a boundary that is enforced per call.
//
// guardedNcCall passes the executor as a callback, so a guarded site reads
// `guardedNcCall(tool, args, ctx, () => executeNextcloudXTool(...))` — the
// helper is always a short distance before the executor. LOOKBEHIND is
// generous enough for the multi-line form and far too short to span two
// functions.
const LOOKBEHIND = 400;

function findCallSites(src) {
    const re = new RegExp(CALL_RE.source, 'g');
    const out = [];
    let m;
    while ((m = re.exec(src)) !== null) out.push({ index: m.index, text: m[0] });
    return out;
}

function isGuarded(src, index) {
    return src.slice(Math.max(0, index - LOOKBEHIND), index).includes('guardedNcCall(');
}

function lineOf(src, index) {
    return src.slice(0, index).split('\n').length;
}

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

test('every caller of a Nextcloud executor goes through the scope guard', () => {
    const offenders = [];
    for (const file of walk(SERVER_ROOT)) {
        const rel = path.relative(SERVER_ROOT, file).split(path.sep).join('/');
        // The executor modules define these functions; tests call them freely.
        if (rel.startsWith('integrations/nextcloud')) continue;
        if (rel.includes('.test.js') || rel.startsWith('scripts/')) continue;
        if (EXEMPT.has(rel)) continue;

        const src = fs.readFileSync(file, 'utf8');
        for (const site of findCallSites(src)) {
            if (!isGuarded(src, site.index)) {
                offenders.push(`${rel}:${lineOf(src, site.index)}  ${site.text}`);
            }
        }
    }

    assert.deepEqual(offenders, [],
        'these Nextcloud executor calls do not sit inside an ncScopeGuard.guardedNcCall — '
        + 'wrap the call, or add the file to EXEMPT with a reason:\n  ' + offenders.join('\n  '));
});

test('the exempt list stays honest — each entry still calls an executor', () => {
    // An exemption for a file that no longer calls an executor is dead weight
    // that would silently cover a future call site.
    for (const [rel, why] of EXEMPT) {
        const full = path.join(SERVER_ROOT, rel);
        assert.ok(fs.existsSync(full), `exempt file no longer exists: ${rel}`);
        assert.ok(CALL_RE.test(fs.readFileSync(full, 'utf8')),
            `${rel} is exempt ("${why}") but no longer calls a Nextcloud executor — drop the exemption`);
    }
});
