/**
 * The rule catalog: one entry per finding the analyser can raise.
 *
 * Every message is one plain sentence for someone who did not write the code,
 * because the person reading it may be the colleague who only fills in the
 * parameters. Messages carry no values (no host names, no line numbers): the
 * finding's line says where, and a sentence without placeholders translates
 * cleanly. The i18n keys live in the `code_step` namespace.
 *
 *   block  refuses activation and every run (a draft still saves).
 *   warn   gates activation and publish until someone approves it for the
 *          current code: `approver` says who may. A run that is already live
 *          is never stopped by a warn.
 *   info   a fact about the code, never a gate.
 */

'use strict';

const RULESET_VERSION = 'code-safety/1';

const RULES = Object.freeze({
    'host-internals': {
        severity: 'block',
        message: "This reaches into the sandbox's internal plumbing. Use ctx.http or ctx.integrations instead.",
        fix: 'Remove it and call ctx.http or ctx.integrations.',
    },
    'node-access': {
        severity: 'block',
        message: 'Code steps cannot load modules or reach the server. There are no files or processes here.',
        fix: 'Write the logic in the step itself, or use an integration.',
    },
    'low-level': {
        severity: 'block',
        message: 'Code steps cannot run compiled or multi-threaded code.',
        fix: 'Write the logic in plain JavaScript.',
    },
    'dynamic-code': {
        severity: 'block',
        message: 'Code that writes and runs new code cannot be checked. Write the logic directly.',
        fix: 'Write the logic directly instead of building it from text.',
    },
    mining: {
        severity: 'block',
        message: 'This connects to a crypto-mining service.',
        fix: 'Remove it.',
    },
    'builtin-tampering': {
        severity: 'warn',
        approver: 'admin',
        message: "This changes or inspects JavaScript's built-in objects, which can hide what the code really does.",
        fix: 'Use your own helper function instead of changing built-in ones.',
    },
    obfuscation: {
        severity: 'warn',
        approver: 'admin',
        message: 'Part of this code is hidden or encoded, so nobody can read what it does.',
        fix: 'Write the text or logic out in plain, readable form.',
    },
    'ai-review': {
        severity: 'warn',
        approver: 'admin',
        message: 'An automatic review found this code suspicious. An admin should read it before it goes live.',
        fix: 'Ask an admin to review the code.',
    },
    'hardcoded-secret': {
        severity: 'warn',
        approver: 'author',
        message: 'This looks like a password or key written into the code. Anyone who can open the routine can read it.',
        fix: 'Pass it in as an input, or use an integration that signs in by itself.',
    },
    'dynamic-host': {
        severity: 'warn',
        approver: 'author',
        message: 'This step decides at run time where it sends data. List the hosts it may reach.',
        fix: "Add the hosts under 'Where this step may send data'.",
    },
    'collection-host': {
        severity: 'warn',
        approver: 'author',
        message: 'This address collects or forwards whatever is sent to it, so data sent there leaves your control.',
        fix: 'Send the data to a service your organisation manages instead.',
    },
    'busy-wait': {
        severity: 'warn',
        approver: 'author',
        message: 'This loop keeps the processor busy while it waits, so the step will hit its time limit.',
        fix: 'Remove the waiting loop: a code step cannot pause itself.',
    },
    'tool-not-allowed': {
        severity: 'warn',
        approver: 'author',
        message: 'This calls an app this step is not allowed to use, so the run will refuse the call.',
        fix: "Allow the app for this step, or remove the call.",
    },
    'http-in-loop': {
        severity: 'info',
        message: 'This calls the web inside a loop. One run may make only a few calls, 5 unless the step allows more.',
        fix: 'Collect what you need first and make one call, if the service allows it.',
    },
});

function snake(ruleId) {
    return String(ruleId).replace(/-/g, '_');
}

/** The i18n key of a rule's message, `code_step.rule.<snake_case id>`. */
function messageKeyOf(ruleId) {
    return `code_step.rule.${snake(ruleId)}`;
}

/** The i18n key of a rule's fix hint. */
function fixKeyOf(ruleId) {
    return `code_step.rule.${snake(ruleId)}_fix`;
}

/**
 * A finding for `ruleId` at `node` (anything with an acorn `loc`), or at an
 * explicit `{ line, column }` (1-based). Columns are 1-based, like the editor.
 */
function makeFinding(ruleId, where) {
    const rule = RULES[ruleId];
    if (!rule) throw new Error(`unknown code-safety rule ${ruleId}`);
    const loc = where && where.loc ? where.loc : null;
    const line = loc ? loc.start.line : (where && Number.isInteger(where.line) ? where.line : 1);
    const column = loc ? loc.start.column + 1 : (where && Number.isInteger(where.column) ? where.column : 1);
    const finding = {
        ruleId,
        severity: rule.severity,
        ...(rule.approver ? { approver: rule.approver } : {}),
        line,
        column,
        ...(loc ? { endLine: loc.end.line, endColumn: loc.end.column + 1 } : {}),
        message: rule.message,
        messageKey: messageKeyOf(ruleId),
        ...(rule.fix ? { fix: rule.fix, fixKey: fixKeyOf(ruleId) } : {}),
    };
    return finding;
}

module.exports = { RULESET_VERSION, RULES, makeFinding, messageKeyOf, fixKeyOf };
