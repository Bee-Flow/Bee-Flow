/**
 * The words of an automation notification that leaves Bee Flow's own bell.
 *
 * Personal data leaves Bee Flow by e-mail only (BFSF-441). A Nextcloud
 * notification and a Talk message therefore say three things and nothing
 * else: the automation's name, what happened, and a link. No step output, no
 * error text (an upstream error quotes the payload it choked on), no approval
 * prompt, no names of the people a run was about. The Bee Flow bell and the
 * e-mail keep the detailed message the runner writes.
 *
 * Every text is built from a code and params, with the English sentence as
 * `text`, so a surface that translates can do so from the code.
 */

'use strict';

/** code → English template. `{name}` is the automation, `{count}` a number. */
const MESSAGE_TEXT = Object.freeze({
    'automation.notify.run_failed': '{name} stopped with an error',
    'automation.notify.run_succeeded': '{name} finished',
    'automation.notify.approval_needed': '{name} needs an approval',
    'automation.notify.first_run_confirm': '{name} is waiting for you to confirm its first real run',
    'automation.notify.schedule_idle': 'A schedule of {name} will not run again',
    'automation.notify.schedule_disabled': '{name} was paused: its schedule has no next run',
    'automation.notify.bundle.onError': '{name}: {count} more errors in the last hour',
    'automation.notify.bundle.onSuccess': '{name}: {count} more finished runs in the last hour',
    'automation.notify.bundle.onApproval': '{name}: {count} more approvals waiting',
    'automation.notify.digest.subject': 'Your automations today',
});

/** The code an event uses when the caller names none. */
const DEFAULT_CODE = Object.freeze({
    onError: 'automation.notify.run_failed',
    onSuccess: 'automation.notify.run_succeeded',
    onApproval: 'automation.notify.approval_needed',
});

/** An automation name fit for one line: trimmed, no line breaks, capped. */
function automationName(title) {
    const clean = String(title || '').replace(/\s+/g, ' ').trim();
    if (!clean) return 'An automation';
    return clean.length > 120 ? `${clean.slice(0, 119)}…` : clean;
}

function fill(template, params) {
    return template.replace(/\{(\w+)\}/g, (m, key) => (params[key] != null ? String(params[key]) : m));
}

/**
 * The one-line text for Nextcloud and Talk.
 *
 * @param {{ event: string, code?: string|null, title?: string, count?: number }} p
 * @returns {{ code: string, params: object, text: string }}
 */
function shortMessage({ event, code = null, title = '', count = null }) {
    const chosen = code && MESSAGE_TEXT[code] ? code : (DEFAULT_CODE[event] || 'automation.notify.run_failed');
    const params = { name: automationName(title), ...(count != null ? { count } : {}) };
    return { code: chosen, params, text: fill(MESSAGE_TEXT[chosen], params) };
}

/** The "n more" message for held-back notifications of one event. */
function bundleMessage({ event, title = '', count }) {
    const code = MESSAGE_TEXT[`automation.notify.bundle.${event}`] ? `automation.notify.bundle.${event}` : 'automation.notify.bundle.onError';
    const params = { name: automationName(title), count: Number(count) || 0 };
    return { code, params, text: fill(MESSAGE_TEXT[code], params) };
}

/** A Talk message: the line, then the link on its own line. */
function talkText(line, url) {
    return url ? `${line}\n${url}` : line;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The daily summary for one person.
 *
 * `items`: one per automation, { title, runs, failures, waiting, held }, where
 * `held` counts notifications that waited for this summary (success runs in
 * summary mode, throttled messages). Automations where nothing happened and
 * nothing waits are left out; when that leaves nothing, there is no summary
 * (returns null) rather than a message that says nothing.
 *
 * The bell/Nextcloud line keeps to totals; the per-automation lines (automation
 * names and counts, no run data) are for the Bee Flow bell and the e-mail.
 *
 * @param {{ items: Array<{ automationId?: string, title: string, runs: number, failures: number, waiting: number, held?: number }>, link?: string|null }} p
 */
function composeDigest({ items, link = null }) {
    const rows = (Array.isArray(items) ? items : [])
        .map(i => ({
            automationId: i.automationId || null,
            title: automationName(i.title),
            runs: Number(i.runs) || 0,
            failures: Number(i.failures) || 0,
            waiting: Number(i.waiting) || 0,
            held: Number(i.held) || 0,
        }))
        .filter(i => i.runs || i.failures || i.waiting || i.held)
        .sort((a, b) => (b.failures - a.failures) || (b.waiting - a.waiting) || (b.runs - a.runs) || a.title.localeCompare(b.title));
    if (!rows.length) return null;

    const totals = rows.reduce((t, r) => ({
        runs: t.runs + r.runs, failures: t.failures + r.failures, waiting: t.waiting + r.waiting,
    }), { runs: 0, failures: 0, waiting: 0 });

    const params = { ...totals, automations: rows.length };
    const summaryParts = [plural(totals.runs, 'run', 'runs')];
    summaryParts.push(totals.failures ? `${totals.failures} failed` : 'none failed');
    if (totals.waiting) summaryParts.push(`${totals.waiting} still waiting`);
    const summary = summaryParts.join(', ');

    const lines = rows.map((r) => {
        const bits = [plural(r.runs, 'run', 'runs')];
        if (r.failures) bits.push(`${r.failures} failed`);
        if (r.waiting) bits.push(`${r.waiting} waiting`);
        return `${r.title}: ${bits.join(', ')}`;
    });

    return {
        code: 'automation.notify.digest',
        params,
        subject: MESSAGE_TEXT['automation.notify.digest.subject'],
        shortText: `${MESSAGE_TEXT['automation.notify.digest.subject']}: ${summary}`,
        text: [summary, '', ...lines].join('\n'),
        items: rows,
        link,
    };
}

module.exports = { MESSAGE_TEXT, DEFAULT_CODE, automationName, shortMessage, bundleMessage, talkText, composeDigest };
