/**
 * datetime step (extracted verbatim from engine.js): single and list-mode
 * date operations (parse/format/add/diff/extract).
 */

const { resolveArrayRef, skippedArrayRef } = require('./execCollections');
const { impliedListMode } = require('../../automation/datetimeListMode');

/**
 * Apply ONE date/time operation. We accept ISO strings and JS-parseable
 * date strings; ints (epoch ms) too. Output normalises to ISO + a
 * formatted `value` (matches the format string when op === 'format',
 * otherwise equal to ISO).
 *
 * Two modes, on the platform's usual `arrayRef` convention:
 *
 *   single  — no `arrayRef` key: one date in, one result out.
 *   list    — `arrayRef` present: work through a table and ADD A COLUMN to
 *             every row (BFSF-375). Dropping a whole column of dates into
 *             "Input date" used to hand `toDate` an array of 17 strings,
 *             which parses as nothing, so the step failed with "did not
 *             resolve to a parseable date" — a dead end for anything that
 *             processes a query result.
 */
async function execDateTime(step, ctx, runState) {
    // A step saved with a whole column in "Input date" but no `arrayRef`
    // (before the builder converted it, or imported / AI-written) is list
    // mode in all but name — see automation/datetimeListMode.js.
    const implied = impliedListMode(step);
    if (implied) return execDateTimeList({ ...step, ...implied }, runState);
    if (typeof step.arrayRef !== 'string') return execDateTimeSingle(step, runState);
    return execDateTimeList(step, runState);
}

function execDateTimeSingle(step, runState) {
    return { output: datetimeResult(step, runState) };
}

/**
 * The column a list-mode result lands in. Named after what it holds, so
 * `extract` with part `day` gives you a column called `day` — which is what
 * an author staring at a table expects to appear.
 */
function datetimeTargetColumn(step) {
    if (typeof step.target === 'string' && step.target.trim()) return step.target.trim();
    if (step.op === 'extract' && step.part) return String(step.part);
    if (step.op === 'diff') return 'diff';
    if (step.op === 'format') return 'formatted';
    return String(step.op || 'value');
}

function execDateTimeList(step, runState) {
    const arr = resolveArrayRef(step, runState);
    if (!arr) return skippedArrayRef(step, runState, { items: [], count: 0 });

    const target = datetimeTargetColumn(step);
    const rows = [];
    let failed = 0;
    for (let i = 0; i < arr.length; i++) {
        const rowScope = { ...runState, item: arr[i], _index: i };
        const base = (arr[i] !== null && typeof arr[i] === 'object' && !Array.isArray(arr[i]))
            ? { ...arr[i] }
            : { value: arr[i] };
        try {
            base[target] = datetimeResult(step, rowScope).value;
        } catch {
            // Rows in = rows out (the rule execSet follows). One unreadable
            // cell in a long table is a data problem, not a reason to fail the
            // run — but it is counted and reported below, never silent.
            base[target] = null;
            failed += 1;
        }
        rows.push(base);
    }

    // Every row failed: that is not bad data, that is the wrong column. Say so
    // as a SKIP rather than handing on a table of nulls that looks successful
    // (the same call aggregate/summarize make when no item carries the field).
    if (rows.length && failed === rows.length) {
        return {
            output: {
                items: [],
                count: 0,
                skipped: `No row's \`${step.input}\` held a date this step could read, so no \`${target}\` column was added. Check the column you pointed at.`,
            },
            skippedReason: 'datetime_unresolved_input',
        };
    }
    return {
        output: {
            items: rows,
            count: rows.length,
            ...(failed ? { warning: `${failed} of ${rows.length} rows had no readable date; their \`${target}\` is null.` } : {}),
        },
    };
}

/**
 * One operation against one runState scope. Throws exactly as before when the
 * input will not parse — list mode catches per row, single mode lets it fly.
 */
function datetimeResult(step, runState) {
    const op = step.op;
    const bind = require('../../automation/bind');
    // A resolvable path takes precedence; when walkPath misses, fall back to
    // treating the config value as a LITERAL date string ("2026-07-01") so
    // fixed dates work without a ref. An unresolvable non-date string still
    // fails toDate() below with the same error as before.
    const resolveDateInput = (raw) => {
        if (!raw) return null;
        const resolved = bind.walkPath(raw, runState);
        return resolved === undefined || resolved === null ? raw : resolved;
    };
    const inputAt = resolveDateInput(step.input);
    const inputAt2 = resolveDateInput(step.input2);

    const toDate = (v) => {
        if (v == null) return null;
        if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
        if (typeof v === 'number') return new Date(v);
        if (typeof v === 'string') { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; }
        return null;
    };

    if (op === 'now') {
        const d = new Date();
        return { iso: d.toISOString(), value: d.toISOString() };
    }
    const d = toDate(inputAt);
    if (!d) {
        // Fail LOUD (A17): the error-stub output used to be recorded as a
        // green SUCCESS while every downstream binding read null — routes
        // through on_error edges / run-error recording like any other step
        // failure now.
        const err = new Error(`datetime: input "${step.input ?? ''}" did not resolve to a parseable date`);
        err.errorClass = 'datetime_unresolved_input';
        throw err;
    }
    if (op === 'parse') return { iso: d.toISOString(), value: d.toISOString() };
    if (op === 'format') {
        // Lightweight token formatter — enough for the common patterns
        // (yyyy-MM-dd HH:mm) without pulling in date-fns just for this.
        const pad = (n, w = 2) => String(n).padStart(w, '0');
        const tokens = {
            yyyy: d.getFullYear(),
            MM: pad(d.getMonth() + 1),
            dd: pad(d.getDate()),
            HH: pad(d.getHours()),
            mm: pad(d.getMinutes()),
            ss: pad(d.getSeconds()),
        };
        const out = String(step.format).replace(/yyyy|MM|dd|HH|mm|ss/g, m => tokens[m]);
        return { iso: d.toISOString(), value: out };
    }
    if (op === 'addDays' || op === 'addHours' || op === 'addMinutes') {
        const ms = op === 'addDays' ? 86_400_000 : op === 'addHours' ? 3_600_000 : 60_000;
        const next = new Date(d.getTime() + Number(step.amount || 0) * ms);
        return { iso: next.toISOString(), value: next.toISOString() };
    }
    if (op === 'diff') {
        const d2 = toDate(inputAt2);
        if (!d2) {
            const err = new Error(`datetime: diff input2 "${step.input2 ?? ''}" did not resolve to a parseable date`);
            err.errorClass = 'datetime_unresolved_input';
            throw err;
        }
        const diffMs = d2.getTime() - d.getTime();
        const div = step.unit === 'days' ? 86_400_000 : step.unit === 'hours' ? 3_600_000 : step.unit === 'minutes' ? 60_000 : 1_000;
        return { value: diffMs / div, unit: step.unit };
    }
    if (op === 'extract') {
        const map = {
            year: d.getFullYear(),
            month: d.getMonth() + 1,
            day: d.getDate(),
            hour: d.getHours(),
            minute: d.getMinutes(),
            second: d.getSeconds(),
            dayOfWeek: d.getDay(),
        };
        return { value: map[step.part], part: step.part };
    }
    // Validator-blocked, but hand-written definitions can still reach it —
    // fail loud rather than record a success with a null value (A17).
    const err = new Error(`Unknown datetime op: ${op}`);
    err.errorClass = 'datetime_op_unknown';
    throw err;
}

module.exports = { execDateTime };
