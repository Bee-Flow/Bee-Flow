/**
 * Control-flow steps (extracted verbatim from engine.js): condition, the
 * switch family (scalar/collection/list modes), wait and stop_error — plus
 * return_to_app, the second TERMINAL step (see validate/constants.js's
 * TERMINAL_STEP_TYPES for the full list of readers).
 */

const { evaluate } = require('../../automation/expr');
const { resolveArrayRef, skippedArrayRef } = require('./execCollections');
const { parseTopicExpr, prepareTopics } = require('./topicHost');
// Literals only, no requires of its own — the validator's vocabulary module is
// safe to pull into the runner, and sharing it is the point: the values the
// validator accepts and the values the runner forwards to the app must be the
// same list, or a step saves green and arrives at the browser as nothing.
const {
    RETURN_TO_APP_REFRESH_MODES, RETURN_TO_APP_ON_ERROR_MODES, RETURN_TO_APP_TOAST_TONES,
    RETURN_TO_APP_MAX_TOAST_CHARS, RETURN_TO_APP_MAX_RECORD_REF_CHARS,
} = require('../../automation/validate/constants');

async function execCondition(step, ctx, runState) {
    let v = false;
    let evalError = null;
    let ast = null;
    try { ast = parseTopicExpr(step.expr || 'false'); }
    catch (e) { evalError = e.message || String(e); }
    let topics = null;
    if (ast) {
        // "is about" rules are answered by the classifier before evaluation;
        // its failures throw from here and fail the step (topicHost.js).
        const prep = await prepareTopics([ast], () => [runState], ctx);
        topics = prep.summary;
        try { v = evaluate(ast, runState, prep.host ? { host: prep.host } : undefined); }
        catch (e) {
            if (e.topicFatal) throw e;
            v = false; evalError = e.message || String(e);
        }
    }
    return { output: { branch: v ? 'then' : 'else', value: !!v, expr: step.expr, ...(topics ? { topics } : {}), ...(evalError ? { _evalError: evalError } : {}) } };
}

/**
 * Pause the runner. Capped at 24h to keep a misconfigured cron from
 * holding a runner pod hostage. Dry-run skips the actual sleep so a
 * preview doesn't make the user wait.
 */
async function execWait(step, ctx, runState, mode) {
    const seconds = Math.max(1, Math.min(86400, Number(step.seconds) || 1));
    if (mode === 'dry_run') {
        return { output: { waitedSeconds: 0, _dryRun: true, plannedSeconds: seconds } };
    }
    // Sleep time must not count against the run's hard-timeout budget (A8):
    // the form offers minutes/hours ("Up to 24 hours") while the default run
    // budget is ~5 minutes, so any longer Wait used to GUARANTEE the run died
    // with "Run hard timeout". Extend the deadline by the planned sleep, then
    // sleep in short cancellable chunks so a user's cancel lands within ~5s
    // instead of after the full wait.
    //
    // The IN-PROCESS deadline is only half of it (W5-16). The automations row
    // carries a second, independent clock: reapStuckAutomations resets any row
    // whose running marker is older than max(REAPER_FLOOR_MS, run_timeout_ms +
    // REAPER_BUFFER_MS) — at most ~61 minutes — while `seconds` goes to 24
    // hours. A wait past that window got the row reaped mid-sleep, which
    // cleared the concurrency marker and let the scheduler start a SECOND run
    // of the same routine while this one was still sleeping. Granting the
    // extension now also refreshes that marker (executeAutomation hangs the
    // refresh off extendRunDeadline + the run heartbeat), so both clocks are
    // driven by the same fact — this runner is still alive — instead of by two
    // unrelated numbers.
    ctx.extendRunDeadline?.(seconds * 1000);
    const until = Date.now() + seconds * 1000;
    while (Date.now() < until) {
        if (ctx.cancelSignal?.aborted) throw new Error('Run cancelled');
        await new Promise(r => {
            const t = setTimeout(r, Math.min(5_000, Math.max(0, until - Date.now())));
            if (t.unref) t.unref();
        });
    }
    // "Once per run" is not a time bound. A run that slept an hour must not
    // answer the next lookup from before the sleep — waiting is usually the
    // author saying "let the other system catch up", which is exactly when a
    // stale answer is worst.
    ctx._toolMemo?.clear?.();
    return { output: { waitedSeconds: seconds } };
}

/**
 * Halt the run with an error message. The message is interpolated as a
 * template so it can include upstream fields (e.g. "budget exceeded by
 * {{steps.calc.output.delta}}"). The thrown error is recorded by the
 * normal error path and surfaces in run history.
 */
async function execStopError(step, ctx, runState) {
    const msg = require('../../automation/bind').interpolateTemplate(step.message || 'Stopped by stop_error step', runState);
    throw new Error(msg);
}

/**
 * `return_to_app` — end the run and hand the Studio App that started it a
 * short instruction set: which screen to open, what to say, what to refresh.
 *
 * ── GEEN NIEUW KANAAL ───────────────────────────────────────────────────────
 * De app-runtime pollt de run al (useActionRunner's pollRun). Het antwoord van
 * die poll draagt `_appEffects` als ZUSTERVELD naast `output` — gebouwd uit de
 * output van DEZE stap, want die staat al in de run-stappen die de brug toch
 * uitleest (appStudio/actionExecutor/automationBridge.deriveAppEffects).
 *
 * Daarom staat het effectenobject onder een `_`-sleutel in de output en niet
 * los ernaast: bindingen dalen alleen af in `output.*` van een gewone stap, en
 * `deriveFinalOutput` slaat een return_to_app-rij over — anders zou het
 * effectenobject de plaats innemen van de echte data waar elke bestaande
 * `actionResult`-binding aan hangt.
 *
 * ── EEN GENEGEERD EFFECT IS NOOIT STIL ──────────────────────────────────────
 * Wat hier niet naar een effect te vertalen valt — een scherm dat niet gekozen
 * is, een toast die tot niets interpoleert, een `refresh` buiten het
 * vocabulaire — wordt WEGGELATEN uit `_appEffects` én vastgelegd in
 * `output._ignored` (de stap-rij die de runweergave toont) plus een regel op
 * `_templateWarnings`. Een instructie die de bezoeker nooit ziet, is precies
 * het probleem dat deze stap moest oplossen; hem stil laten verdwijnen zou dat
 * probleem verplaatsen in plaats van oplossen.
 *
 * Het object wordt uit een ALLOW-LIST opgebouwd, nooit door sleutels van de
 * stap te verwijderen: een veld dat volgend jaar aan een stap wordt toegevoegd
 * mag niet vanzelf mee de browser in reizen.
 */
async function execReturnToApp(step, ctx, runState) {
    const { interpolateTemplate } = require('../../automation/bind');
    const ignored = [];
    const drop = (field, reason) => {
        ignored.push({ field, reason });
        const line = `return_to_app ${step.id}: ignored "${field}" — ${reason}`;
        const list = runState && runState._templateWarnings;
        if (Array.isArray(list) && !list.includes(line)) list.push(line);
    };
    const effects = {};

    // Where the visitor lands. `params.id` is the name every App Studio detail
    // screen reads its record from (`screen.params.id`), so a recordRef that
    // resolves lands there rather than under a name nothing binds to.
    const nav = step.navigateTo;
    if (nav !== undefined && nav !== null) {
        const screenId = (nav && typeof nav.screenId === 'string') ? nav.screenId.trim() : '';
        if (!screenId) {
            drop('navigateTo', 'no screen was picked, so the app has nowhere to go');
        } else {
            const entry = { screenId };
            if (typeof nav.recordRef === 'string' && nav.recordRef.trim()) {
                const resolved = String(interpolateTemplate(nav.recordRef, runState) ?? '').trim();
                if (resolved) entry.params = { id: resolved.slice(0, RETURN_TO_APP_MAX_RECORD_REF_CHARS) };
                else drop('navigateTo.recordRef', 'it resolved to nothing, so the screen would open without a record');
            }
            effects.navigateTo = entry;
        }
    }

    // What the visitor reads. Template-interpolated like stop_error's message.
    const toast = step.toast;
    if (toast !== undefined && toast !== null) {
        const raw = (toast && typeof toast.message === 'string') ? toast.message : '';
        const message = raw ? String(interpolateTemplate(raw, runState) ?? '').trim() : '';
        if (!message) {
            drop('toast', raw ? 'the message resolved to nothing' : 'there is no message to show');
        } else {
            if (toast.tone !== undefined && toast.tone !== null && !RETURN_TO_APP_TOAST_TONES.has(toast.tone)) {
                drop('toast.tone', `${JSON.stringify(toast.tone)} is not a tone the app knows — it was shown as "info"`);
            }
            effects.toast = {
                message: message.slice(0, RETURN_TO_APP_MAX_TOAST_CHARS),
                tone: RETURN_TO_APP_TOAST_TONES.has(toast.tone) ? toast.tone : 'info',
            };
        }
    }

    if (step.refresh !== undefined && step.refresh !== null) {
        if (RETURN_TO_APP_REFRESH_MODES.has(step.refresh)) effects.refresh = step.refresh;
        else drop('refresh', `${JSON.stringify(step.refresh)} is not something the app knows how to refresh`);
    }

    // Wat de app doet als de terugkeer zélf niet uitvoerbaar is. ONBEKEND
    // VERSMALT: zowel een waarde buiten het vocabulaire als een ontbrekende
    // waarde wordt 'stay' — de bezoeker blijft staan waar hij staat. Een
    // gegokte navigatie naar een foutscherm is de duurdere fout.
    if (step.onError !== undefined && step.onError !== null && !RETURN_TO_APP_ON_ERROR_MODES.has(step.onError)) {
        drop('onError', `${JSON.stringify(step.onError)} is not a fallback the app knows — it stays where it is`);
    }
    effects.onError = RETURN_TO_APP_ON_ERROR_MODES.has(step.onError) ? step.onError : 'stay';

    return { output: { _appEffects: effects, ...(ignored.length ? { _ignored: ignored } : {}) } };
}

/**
 * Multi-way branch. expr is evaluated under the restricted grammar; the
 * resulting value is matched against each case's `value` (loose equality
 * — coerces strings/numbers as the user typed them). Output.branch is
 * `case:<matchedName>` (or `case:default`); the runner reads it to
 * follow the matching outgoing edge.
 */
/**
 * Collection-mode source resolution for a switch whose expr is a COLUMN path
 * (`<base>[*].<field>`): return the table's ROWS aligned with each row's
 * switch VALUE, so matches can carry the full row to the branch. A non-column
 * array expr (function results etc.) treats the elements as both row and
 * value. Null rows are skipped (same as the wildcard flatten).
 */
function resolveSwitchCollection(expr, arrayValue, runState) {
    const m = /^\s*([A-Za-z_$][\w$]*(?:\.[\w$]+|\[(?:\d+|"[^"]*"|'[^']*')\])*)\[\*\]\.([\w$.]+)\s*$/.exec(String(expr || ''));
    if (m) {
        const bind = require('../../automation/bind');
        const base = bind.walkPath(m[1], runState);
        if (Array.isArray(base)) {
            const rows = [];
            const values = [];
            for (const row of base) {
                if (row == null) continue;
                rows.push(row);
                values.push(bind.walkRelativePath(m[2], row));
            }
            return { rows, values };
        }
    }
    const flat = arrayValue.filter(x => x != null);
    return { rows: flat, values: flat };
}

/**
 * Does a switch case match? Two case shapes, deliberately coexisting on one
 * step so the unified "Filter & Route" editor can offer a single rule list:
 *
 *   RULE case  — `{ name, expr }`: its own boolean expression, evaluated
 *                against `scope` (in list mode the row is bound as `item`).
 *   VALUE case — `{ name, value }`: the legacy shape, compared against the
 *                step-level expr's value with loose + case-insensitive
 *                equality, plus substring for text.
 *
 * Returns null for "this case has no rule", so the caller can fall back to
 * value matching. Errors count as "no match" and are reported once.
 */
function switchCaseRule(cc, scope, onError, host) {
    if (!cc.rule) return null;
    if (!cc.ast) { onError(cc.parseError); return false; }
    try { return !!evaluate(cc.ast, scope, host ? { host } : undefined); }
    catch (e) {
        if (e.topicFatal) throw e;
        onError(e.message || String(e));
        return false;
    }
}

/**
 * Parse every RULE case once per step, not once per row: a list-mode switch
 * used to re-tokenise each case for every row it offered it. A case whose
 * rule does not parse keeps its message, and every row it is asked about
 * reports it and does not match, exactly as the per-row parse did.
 */
function compileSwitchCases(cases) {
    return cases.map((c) => {
        if (!c || typeof c.expr !== 'string' || !c.expr.trim()) return { c, rule: false, ast: null };
        try { return { c, rule: true, ast: parseTopicExpr(c.expr) }; }
        catch (e) { return { c, rule: true, ast: null, parseError: e.message || String(e) }; }
    });
}

/** Loose + case-insensitive value match, with substring for text cells. */
function switchValueMatches(cell, caseValue) {
    if (cell == caseValue) return true;
    return typeof cell === 'string' && typeof caseValue === 'string'
        && caseValue !== '' && cell.toLowerCase().includes(caseValue.toLowerCase());
}

/**
 * How this switch treats a record that matches more than one case (BFSF-356).
 *
 *   'first' — the first matching case takes it, and only that one.
 *   'all'   — every case is asked independently, none of them consumes the
 *             record, so the same record can travel several outputs.
 *
 * ABSENT is 'first', and that default is the entire compatibility mechanism:
 * every switch ever saved was evaluated first-match-wins, so fanning out
 * unconditionally would give stored routers duplicate emails, duplicate
 * tickets and duplicate API writes for customers who changed nothing.
 *
 * An unrecognised value falls back to 'first' here as defence in depth — the
 * validator REJECTS it (`switch.matchMode_invalid`) so a typo can never reach
 * a live run, and if one somehow did, "behaves like it always has" is the only
 * safe reading of a value nobody understands.
 */
function switchMatchMode(step) {
    return step?.matchMode === 'all' ? 'all' : 'first';
}

/**
 * Split `rows` across the cases and build the collection-mode output. Shared
 * by both list sources: an explicit `arrayRef` (the unified node's "work
 * through a list" mode) and a column-path expr like `…results[*].subject`.
 * `values[i]` is the cell a VALUE case compares against; a RULE case sees the
 * whole row as `item`.
 *
 * Under matchMode 'all' a row is offered to EVERY case and lands in every
 * bucket that fires, so the per-case counts can legitimately sum to more than
 * `total` — that is the point of the feature. `total` still reports what came
 * in and the default bucket still holds exactly what matched nothing, so a
 * rejected record stays visible in the counters either way.
 */
function partitionSwitchRows(step, compiled, rows, values, runState, onError, host) {
    const fanOut = switchMatchMode(step) === 'all';
    const matchesByCase = {};
    for (const { c } of compiled) { if (c?.name) matchesByCase[c.name] = []; }
    const defaultRows = [];
    rows.forEach((row, i) => {
        let hitAny = false;
        for (const cc of compiled) {
            const c = cc.c;
            if (!c?.name) continue;
            const rule = switchCaseRule(cc, { ...runState, item: row, _index: i }, onError, host);
            const hit = rule === null ? switchValueMatches(values[i], c.value) : rule;
            if (!hit) continue;
            matchesByCase[c.name].push(row);
            hitAny = true;
            // 'first': stop at the first match — same cases visited, same
            // order, same number of evaluations as the old `cases.find()`.
            if (!fanOut) break;
        }
        if (!hitAny) defaultRows.push(row);
    });
    // `viaDefault` marks a defaultBranch REDIRECT — the same marker the scalar
    // path sets, and for the same reason: runDag needs it to rescue the rows via
    // a wired `case:default` port when the case they were redirected INTO turns
    // out to have no outgoing edge. Only the scalar path ever set it, so in
    // collection mode the redirect silently swallowed every unmatched row while
    // `matched` still read non-null and the run finished green (W4-12).
    let viaDefault = false;
    if (defaultRows.length && step.defaultBranch && matchesByCase[step.defaultBranch]) {
        matchesByCase[step.defaultBranch].push(...defaultRows);
        viaDefault = true;
    } else if (defaultRows.length) {
        matchesByCase.default = defaultRows;
    }
    const branches = Object.entries(matchesByCase)
        .filter(([, arr]) => arr.length > 0)
        .map(([name]) => `case:${name}`);
    const counts = Object.fromEntries(Object.entries(matchesByCase).map(([k, arr]) => [k, arr.length]));
    return {
        mode: 'collection',
        branch: branches[0] || 'case:default',
        branches,
        matchesByCase,
        counts,
        total: rows.length,
        matched: branches.length ? branches.map(b => b.slice(5)).join(',') : null,
        ...(viaDefault ? { viaDefault: true } : {}),
    };
}

/**
 * The cell each VALUE case compares against, one per row, for a LIST-mode
 * switch (an explicit `arrayRef` source).
 *
 * The step-level `expr` was never evaluated here: `values` was just the row
 * array, so a VALUE case compared its `value` against the WHOLE row object and
 * every object row fell through to default (W4-13). The scalar path evaluates
 * `expr` against the run state; the column path (`…results[*].subject`) reads
 * the named field off each row — this is the same idea for the third source
 * shape, evaluated in the per-row scope a RULE case already sees (`item`), so
 * `item.status` means the same thing in both kinds of case.
 *
 * Falls back to the row itself when there is no expr, or when the expr does not
 * address anything on this row: a list of plain strings matched by value has
 * always worked that way and must keep working.
 */
function switchRowValues(step, rows, runState, onError) {
    const expr = typeof step.expr === 'string' ? step.expr.trim() : '';
    if (!expr) return rows;
    return rows.map((row, i) => {
        try {
            const v = evaluate(expr, { ...runState, item: row, _index: i });
            return v === undefined ? row : v;
        } catch (e) {
            onError(e.message || String(e));
            return row;
        }
    });
}

/** The rows a collection-mode switch offers its cases, as evaluation scopes. */
function rowScopes(rows, runState) {
    return function* scopes() {
        for (let i = 0; i < rows.length; i++) yield { ...runState, item: rows[i], _index: i };
    };
}

async function execSwitch(step, ctx, runState) {
    const cases = Array.isArray(step.cases) ? step.cases : [];
    const compiled = compileSwitchCases(cases);
    const caseAsts = compiled.map((cc) => cc.ast);
    let evalError = null;
    const onError = (msg) => { if (!evalError) evalError = msg; };

    // ── List mode: an explicit source list ───────────────────────────────
    // `arrayRef` is what the unified Filter & Route node sets when the user
    // says "work through a list": every ROW is offered to each rule in turn
    // (the rule sees it as `item`), and every rule that caught at least one
    // row fires its branch carrying those rows. One rule + no wired default
    // is exactly a filter; several rules is a per-item split.
    if (typeof step.arrayRef === 'string' && step.arrayRef.trim()) {
        const arr = resolveArrayRef(step, runState);
        if (!arr) return skippedArrayRef(step, runState, { mode: 'collection', branch: 'case:default', branches: [], matchesByCase: {}, counts: {}, total: 0 });
        const { host, summary } = await prepareTopics(caseAsts, rowScopes(arr, runState), ctx);
        const output = partitionSwitchRows(step, compiled, arr, switchRowValues(step, arr, runState, onError), runState, onError, host);
        return { output: { ...output, ...(summary ? { topics: summary } : {}), ...(evalError ? { _evalError: evalError } : {}) } };
    }

    let v;
    try { v = evaluate(step.expr || 'null', runState); }
    catch (e) { v = null; evalError = e.message || String(e); }

    // ── Collection mode: switching on a table COLUMN ─────────────────────
    // When the expr resolves to an ARRAY (e.g. `steps.g1.output.results[*]
    // .subject`, expressible since the wildcard grammar fix), the switch
    // partitions the ROWS per case instead of comparing one scalar:
    //   - every case with ≥1 matching row fires ITS branch (runDag follows
    //     all of output.branches), carrying the matching rows at
    //     `output.matchesByCase.<caseName>`;
    //   - unmatched rows go to `defaultBranch`'s bucket when set, else to
    //     the `default` bucket/port. String case values match by loose
    //     equality OR substring (a column cell "Re: Pitchdeck Bee Flow"
    //     matches case value "Pitchdeck").
    if (Array.isArray(v)) {
        const { rows, values } = resolveSwitchCollection(step.expr, v, runState);
        const { host, summary } = await prepareTopics(caseAsts, rowScopes(rows, runState), ctx);
        const output = partitionSwitchRows(step, compiled, rows, values, runState, onError, host);
        return { output: { ...output, ...(summary ? { topics: summary } : {}), ...(evalError ? { _evalError: evalError } : {}) } };
    }

    // ── Scalar mode: one value, one (or under fan-out, several) outputs ──
    const { host, summary: topics } = await prepareTopics(caseAsts, () => [runState], ctx);
    const fanOut = switchMatchMode(step) === 'all';
    const hits = [];
    for (const cc of compiled) {
        const c = cc.c;
        // A rule case decides on its own; a value case compares against the
        // step expr with loose equality (the user typed "3", the payload
        // carries 3) AND case-insensitively for text — the same promise the
        // text operators make: matching a human-entered value never depends
        // on capitalisation.
        const rule = switchCaseRule(cc, runState, onError, host);
        let hit;
        if (rule !== null) hit = rule === true;
        else if (v == c.value) hit = true;
        else hit = typeof v === 'string' && typeof c.value === 'string'
            && v.toLowerCase() === c.value.toLowerCase();
        if (!hit) continue;
        hits.push(c.name);
        // 'first' stops here — identical evaluation order and count to the
        // break-on-match loop this replaced.
        if (!fanOut) break;
    }
    let matched = hits.length ? hits.join(',') : null;
    // `viaDefault` marks a defaultBranch REDIRECT (nothing matched, the step
    // config named a case to fall back to). runDag uses it to rescue the run
    // via a wired `case:default` port when the named case turns out to have
    // no outgoing edge — without the marker, that dead-end was silently
    // recorded as a successful run that executed nothing further (A4/A5).
    let viaDefault = false;
    if (!matched && step.defaultBranch) { matched = step.defaultBranch; viaDefault = true; }
    const branchName = hits[0] || matched || 'default';
    return {
        output: {
            branch: `case:${branchName}`,
            // Fan-out reuses `output.branches` — the SAME key runDag's existing
            // union already follows for the collection path — rather than
            // inventing a second routing mechanism. `branch` (singular) stays
            // the FIRST of them so replay, recorded run rows and the canvas
            // keep reading what they always read. A first-match switch emits no
            // `branches` key at all, so its output shape is unchanged.
            ...(fanOut ? { branches: hits.map(n => `case:${n}`) } : {}),
            matched: matched || null,
            ...(viaDefault ? { viaDefault: true } : {}),
            value: v,
            ...(topics ? { topics } : {}),
            ...(evalError ? { _evalError: evalError } : {}),
        },
    };
}

module.exports = { execCondition, execWait, execStopError, execReturnToApp, execSwitch };
