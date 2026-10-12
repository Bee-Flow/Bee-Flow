'use strict';

/**
 * What of a thrown error a compliance record or a log line may carry.
 *
 * Checks read the database, and a Postgres error message routinely quotes the
 * value that broke the query (`Key (email)=(…) already exists`, `invalid input
 * syntax for type uuid: "…"`). A result row is shown to admins, and the
 * evidence chain (compliance_evidence) is append-only and can never be
 * corrected, so `e.message` must reach neither, nor the server log. What may
 * be recorded is the error's class name and its code (a SQLSTATE for a pg
 * error, an errno name such as ECONNREFUSED for a socket): enough to tell a
 * missing table from a dropped connection, and nothing taken from a row.
 */

/**
 * `{ name, code }` of a thrown value: strings only, bounded, never the message.
 * @param {any} e
 * @returns {{ name: string, code: string|null }}
 */
function errorShape(e) {
    const name = typeof e?.name === 'string' && e.name ? e.name.slice(0, 80) : 'Error';
    const rawCode = e?.code;
    const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode).slice(0, 64) : null;
    return { name, code };
}

/**
 * "TypeError" or "error (code 42P01)": the part of an error a log line or a
 * details sentence may carry.
 * @param {any} e
 */
function errorLabel(e) {
    const { name, code } = errorShape(e);
    return code ? `${name} (code ${code})` : name;
}

/**
 * The stack's frames without its message. e.stack begins with
 * "<name>: <message>", and the message may span lines, so the message is cut
 * out of the stack first (a message line can itself read "    at …") and
 * then only the "at …" lines are kept: they name source locations, never data.
 * @param {any} e
 */
function stackFrames(e) {
    let stack = typeof e?.stack === 'string' ? e.stack : '';
    const message = typeof e?.message === 'string' ? e.message : '';
    const at = message ? stack.indexOf(message) : -1;
    if (at !== -1) stack = stack.slice(0, at) + stack.slice(at + message.length);
    return stack.split('\n').filter(line => /^\s+at\s/.test(line)).slice(0, 12).join('\n');
}

module.exports = { errorShape, errorLabel, stackFrames };
