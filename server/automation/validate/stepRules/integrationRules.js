/**
 * The steps that call something OUTSIDE Bee Flow — an app action through the
 * tool catalog, or a web service over HTTP — together with the two settings
 * that let their answers be reused (`askOnce` within a run, `cacheInto` in a
 * table). The reuse settings live here because those two step types are their
 * only readers: on anything else the runtime never looks at the field, which
 * is the silent no-op those rules exist to report.
 */

const { isObject, hasText } = require('../helpers');
const { isSideEffect, isMemoisable } = require('../../sideEffectMap');
const {
    HTTP_REQUEST_METHODS, HTTP_REQUEST_WRITE_METHODS, CACHE_INTO_MAX_DAYS,
} = require('../constants');

function checkIntegrationAction(ctx, step, at) {
    const { pushE, availableTools, toolRequiredParams } = ctx;
    if (step.type === 'integration_action') {
        if (!step.tool || typeof step.tool !== 'string') pushE({ code: 'integration_action.tool_missing', severity: 'error', path: at + '.tool', message: `Step ${step.id}: integration_action requires \`tool\`.`, hint: 'Pick a tool from the catalog and pass it as a string.' });
        else if (availableTools && !availableTools.has(step.tool)) pushE({ code: 'integration_action.tool_unknown', severity: 'error', path: at + '.tool', message: `Step ${step.id}: tool "${step.tool}" not in user\'s catalog.`, hint: 'Either pick a tool the user has connected or ask them to connect the integration.' });
        // Required-input check (only when caller supplied the schema map).
        // Absent or empty-string-literal required inputs would fail at run
        // time with a tool-side "X is required" error; catch it at activate.
        else if (toolRequiredParams && Array.isArray(toolRequiredParams[step.tool])) {
            const inputs = isObject(step.inputs) ? step.inputs : {};
            for (const param of toolRequiredParams[step.tool]) {
                const b = inputs[param];
                const absent = b === undefined || b === null;
                const emptyLiteral = isObject(b) && b.kind === 'literal'
                    && (b.value === '' || b.value === undefined || b.value === null);
                if (absent || emptyLiteral) {
                    pushE({ code: 'integration_action.param_missing', severity: 'error', path: at + '.inputs.' + param, message: `Step ${step.id}: tool "${step.tool}" requires input "${param}"${emptyLiteral ? ' but it is set to an empty value' : ''}.`, hint: `Provide "${param}" — bind it to an upstream field (kind:'ref'/'template') or set a non-empty literal.` });
                }
            }
        }
    }
}

function checkHttpRequest(ctx, step, at) {
    const { pushE, pushW, knownConnectionIds } = ctx;
    if (step.type === 'http_request') {
        if (!step.url || !(typeof step.url === 'string' || hasText(step.url))) pushE({ code: 'http_request.url_missing', severity: 'error', path: at + '.url', message: `Step ${step.id}: http_request requires \`url\`.`, hint: 'The URL can include {{...}} template values, e.g. https://api.example.com/users/{{trigger.output.id}}.' });
        const method = String(step.method || 'GET').toUpperCase();
        if (!HTTP_REQUEST_METHODS.has(method)) pushE({ code: 'http_request.method_unsupported', severity: 'error', path: at + '.method', message: `Step ${step.id}: unsupported HTTP method "${step.method}".`, hint: `Use one of: ${[...HTTP_REQUEST_METHODS].join(', ')}.` });
        if (step.headers !== undefined && !isObject(step.headers)) pushE({ code: 'http_request.headers_shape', severity: 'error', path: at + '.headers', message: `Step ${step.id}: http_request.headers must be an object map of {name: value}.`, hint: 'Use { "Content-Type": "application/json", ... }.' });
        else if (isObject(step.headers)) {
            for (const [k, v] of Object.entries(step.headers)) {
                if (typeof v !== 'string') { pushE({ code: 'http_request.header_value_shape', severity: 'error', path: at + `.headers.${k}`, message: `Step ${step.id}: header "${k}" value must be a string.`, hint: 'Header values are template strings, not binding objects.' }); break; }
            }
        }
        if (step.timeoutMs !== undefined && (typeof step.timeoutMs !== 'number' || step.timeoutMs < 1000 || step.timeoutMs > 60_000)) {
            pushE({ code: 'http_request.timeout_range', severity: 'error', path: at + '.timeoutMs', message: `Step ${step.id}: http_request.timeoutMs must be 1000..60000.`, hint: 'Pick a duration in milliseconds (1-60 seconds).' });
        }
        if (step.parseResponse !== undefined && !['auto', 'never', 'always'].includes(step.parseResponse)) {
            pushE({ code: 'http_request.parse_response_invalid', severity: 'error', path: at + '.parseResponse', message: `Step ${step.id}: http_request.parseResponse must be auto, never or always.`, hint: 'Leave it out for auto — the response is parsed into `output.data` when its content-type says JSON.' });
        }
        if (step.blockPrivateTargets !== undefined && typeof step.blockPrivateTargets !== 'boolean') {
            pushE({ code: 'http_request.block_private_targets_shape', severity: 'error', path: at + '.blockPrivateTargets', message: `Step ${step.id}: http_request.blockPrivateTargets must be a boolean.`, hint: 'true (recommended) blocks localhost/private-network/cloud-metadata targets; false allows them.' });
        }
        // step.auth — saved-credential reference: { connectionId } ONLY.
        // Absent/null = no injection (back-compat).
        if (step.auth !== undefined && step.auth !== null) {
            const authShapeOk = isObject(step.auth)
                && typeof step.auth.connectionId === 'string' && step.auth.connectionId.trim()
                && Object.keys(step.auth).every(k => k === 'connectionId');
            if (!authShapeOk) {
                pushE({ code: 'http_request.auth_shape', severity: 'error', path: at + '.auth', message: `Step ${step.id}: http_request.auth must be null or { connectionId: '<id>' }.`, hint: 'Pick a saved HTTP credential in the step\'s Authentication settings — all auth details live on the credential, not the step.' });
            } else {
                if (isObject(step.headers) && Object.keys(step.headers).some(k => k.toLowerCase() === 'authorization')) {
                    pushW({ code: 'http_request.auth_header_conflict', severity: 'warning', path: at + '.headers', message: `Step ${step.id}: a manual Authorization header is set alongside a saved credential.`, hint: 'The credential\'s Authorization header replaces this manual header at run time. Remove the manual header to avoid confusion.' });
                }
                // Only checked when the caller supplied the accessible-
                // connection catalog (activation); pure/sync contexts skip.
                if (knownConnectionIds instanceof Set && !knownConnectionIds.has(step.auth.connectionId)) {
                    pushW({ code: 'http_request.auth_connection_unknown', severity: 'warning', path: at + '.auth.connectionId', message: `Step ${step.id}: this step references an HTTP credential that doesn't exist or isn't accessible to you — the run will fail.`, hint: 'Pick a credential in the step\'s Authentication settings.' });
                }
            }
        }
    }
}

/** `askOnce` — "ask this app only once per run". */
function checkAskOnce(ctx, step, at) {
    const { pushE, pushW } = ctx;
    // ── askOnce ("Ask this app only once per run") ────────────────────
    // Truthiness, matching execIntegrationAction's own `!!step.askOnce`:
    // absent, false, null and '' are all off. The old guard
    // (`!== undefined && !== false`) let a null through into the write
    // check and errored a step whose setting does nothing.
    //
    // SCOPED BY TYPE, and that is the point of this block's shape.
    // execIntegrationAction and execHttpRequest are the only readers, so
    // these are those two steps' rules — not the platform's. Applied to
    // every type (as they were) an askOnce on an ai_step or a code step
    // validated clean and even earned the friendly "your administrator
    // decides" warning, while the runner never looked at the field:
    // exactly the silent no-op that warning exists to stop.
    // Neither rule is a completeness code — those mean "the author hasn't
    // finished typing", which is not what any of these say.
    if (step.askOnce) {
        if (step.type === 'http_request') {
            // A write METHOD is this step's isSideEffect, and it is already
            // what the dry-run gate refuses to dispatch. An ERROR rather
            // than a warning, exactly like integration_action's: a reused
            // answer to "POST this order" means the second order silently
            // never happens. POST-as-query (GraphQL, `_search`) is refused
            // with it — fail closed, the same policy sideEffectMap states.
            const httpMethod = String(step.method || 'GET').toUpperCase();
            if (HTTP_REQUEST_WRITE_METHODS.has(httpMethod)) {
                pushW({ code: 'http_request.ask_once_on_write', severity: 'warning', path: at + '.askOnce', message: `Step ${step.id}: a ${httpMethod} is not promised to be a look-up, so reusing its answer means the call does not happen.`, hint: 'Fine for a POST that only searches (many APIs are). Wrong for one that creates, sends or changes something — that change would silently be skipped.' });
            }
            // Turning the SSRF guard off is a refusal, not a key component:
            // an answer fetched with private targets allowed came from a
            // target that was never screened, and replaying it after a
            // reviewer ticks the box back on launders it past a control they
            // believe is in force. A warning because the definition is
            // valid — it simply never reuses anything.
            if (step.blockPrivateTargets === false) {
                pushW({ code: 'http_request.ask_once_private_targets', severity: 'warning', path: at + '.askOnce', message: `Step ${step.id}: answers are never reused while this step may reach private addresses.`, hint: 'Turn "Block requests to private/internal addresses" back on, or remove the reuse setting.' });
            }
            if (typeof step.askOnce === 'object') {
                const ttl = Number(step.askOnce.ttlSeconds);
                if (step.askOnce.ttlSeconds !== undefined && (!Number.isFinite(ttl) || ttl < 1 || ttl > 900)) {
                    pushE({ code: 'http_request.ask_once_ttl_range', severity: 'error', path: at + '.askOnce.ttlSeconds', message: `Step ${step.id}: reuse an answer for between 1 and 900 seconds.`, hint: 'Leave it empty for the default of five minutes.' });
                }
                if (step.askOnce.acrossRuns !== undefined && typeof step.askOnce.acrossRuns !== 'boolean') {
                    pushE({ code: 'http_request.ask_once_across_runs_type', severity: 'error', path: at + '.askOnce.acrossRuns', message: `Step ${step.id}: "reuse between runs" is on or off.`, hint: 'Leave it out for off.' });
                } else if (step.askOnce.acrossRuns === true) {
                    pushW({ code: 'http_request.ask_once_across_runs_org_gated', severity: 'warning', path: at + '.askOnce.acrossRuns', message: `Step ${step.id}: answers are only kept between runs if your organisation allows it.`, hint: 'An administrator turns this on under Organisation settings — for web service calls specifically; until then this step asks every run.' });
                }
            }
        } else if (step.type === 'integration_action') {
            if (step.tool && isSideEffect(step.tool)) {
                pushE({ code: 'integration_action.ask_once_on_write', severity: 'error', path: at + '.askOnce', message: `Step ${step.id}: "${step.tool}" changes something, so its answer cannot be reused.`, hint: 'Only look-ups can be asked once per run.' });
            } else if (step.tool && !isMemoisable(step.tool)) {
                pushW({ code: 'integration_action.ask_once_not_supported', severity: 'warning', path: at + '.askOnce', message: `Step ${step.id}: "${step.tool}" is asked fresh every time.`, hint: 'Some look-ups change by the minute, or are permission-checked as they run, so their answers are never reused.' });
            }
            if (typeof step.askOnce === 'object') {
                const ttl = Number(step.askOnce.ttlSeconds);
                if (step.askOnce.ttlSeconds !== undefined && (!Number.isFinite(ttl) || ttl < 1 || ttl > 900)) {
                    pushE({ code: 'integration_action.ask_once_ttl_range', severity: 'error', path: at + '.askOnce.ttlSeconds', message: `Step ${step.id}: reuse a look-up for between 1 and 900 seconds.`, hint: 'Leave it empty for the default of five minutes.' });
                }
                // Crossing runs is a different promise from reusing within
                // one, and it is the organisation's to make: the answer is
                // stored. A warning rather than an error because the
                // definition is perfectly valid — it simply does nothing
                // until an admin turns the setting on, and silently doing
                // nothing is the failure this exists to prevent.
                if (step.askOnce.acrossRuns !== undefined && typeof step.askOnce.acrossRuns !== 'boolean') {
                    pushE({ code: 'integration_action.ask_once_across_runs_type', severity: 'error', path: at + '.askOnce.acrossRuns', message: `Step ${step.id}: "reuse between runs" is on or off.`, hint: 'Leave it out for off.' });
                } else if (step.askOnce.acrossRuns === true) {
                    pushW({ code: 'integration_action.ask_once_across_runs_org_gated', severity: 'warning', path: at + '.askOnce.acrossRuns', message: `Step ${step.id}: answers are only kept between runs if your organisation allows it.`, hint: 'An administrator turns this on under Organisation settings; until then this step asks every run.' });
                }
            }
        } else {
            pushW({ code: `${step.type}.ask_once_unsupported`, severity: 'warning', path: at + '.askOnce', message: `Step ${step.id}: "ask only once" does nothing on a ${step.type} step — it runs every time.`, hint: 'Only an app action reuses its answer within a run. Remove the setting, or move the look-up into an app action step.' });
        }
    }
}

/** `cacheInto` — "remember answers in a table". */
function checkCacheInto(ctx, step, at) {
    const { pushE, pushW } = ctx;
    // ── cacheInto ("Remember answers in a table") ─────────────────────
    //
    // The VISIBLE half of the same setting `askOnce` is the invisible half
    // of, and it is validated separately for one reason: the two are
    // independent ticks. An author may keep answers in a table without ever
    // reusing one within a run, and a step carrying only `cacheInto` must
    // not fall into the `ask_once_unsupported` branch below and be told the
    // setting does nothing.
    //
    // The refusals are the SAME refusals, because they are the same call:
    // a reused answer to a write means the second write silently never
    // happens, and an answer fetched with the SSRF guard off came from a
    // target nobody screened.
    if (step.cacheInto !== undefined && step.cacheInto !== null) {
        const ci = step.cacheInto;
        if (!isObject(ci)) {
            pushE({ code: 'http_request.cache_into_shape', severity: 'error', path: at + '.cacheInto', message: `Step ${step.id}: "remember answers in a table" is { datatableId, maxAgeDays }.`, hint: 'Pick a table in the step\'s settings, or remove the setting.' });
        } else if (step.type !== 'http_request') {
            // Scoped by type exactly the way askOnce is: execHttpRequest is
            // the only reader, so on any other step this is a field the
            // runtime never consults — the silent no-op this whole block
            // exists to stop.
            pushW({ code: `${step.type}.cache_into_unsupported`, severity: 'warning', path: at + '.cacheInto', message: `Step ${step.id}: "remember answers in a table" does nothing on a ${step.type} step.`, hint: 'Only a web service call can keep its answers. Remove the setting.' });
        } else {
            if (typeof ci.datatableId !== 'string' || !ci.datatableId.trim()) {
                pushE({ code: 'http_request.cache_into_table_missing', severity: 'error', path: at + '.cacheInto.datatableId', message: `Step ${step.id}: choose the table the answers are kept in.`, hint: 'Pick one of your answer tables, or create one from the step settings.' });
            }
            const httpMethod = String(step.method || 'GET').toUpperCase();
            if (HTTP_REQUEST_WRITE_METHODS.has(httpMethod)) {
                pushW({ code: 'http_request.cache_into_on_write', severity: 'warning', path: at + '.cacheInto', message: `Step ${step.id}: a ${httpMethod} is not promised to be a look-up, so a remembered answer means the call does not happen.`, hint: 'Fine for a POST that only searches (many APIs are). Wrong for one that creates, sends or changes something — that change would silently be skipped.' });
            }
            if (step.blockPrivateTargets === false) {
                pushW({ code: 'http_request.cache_into_private_targets', severity: 'warning', path: at + '.cacheInto', message: `Step ${step.id}: nothing is remembered while this step may reach private addresses.`, hint: 'Turn "Block requests to private/internal addresses" back on, or remove the setting.' });
            }
            if (ci.maxAgeDays !== undefined) {
                const days = Number(ci.maxAgeDays);
                if (!Number.isInteger(days) || days < 1 || days > CACHE_INTO_MAX_DAYS) {
                    pushE({ code: 'http_request.cache_into_max_age_range', severity: 'error', path: at + '.cacheInto.maxAgeDays', message: `Step ${step.id}: reuse a stored answer for between 1 and ${CACHE_INTO_MAX_DAYS} days.`, hint: 'Leave it empty for thirty days.' });
                }
            }
            // Said once, where the author is looking: the row is ordinary
            // table data. The hidden tier is encrypted and unreadable; this
            // one is not, and nobody would guess the difference.
            pushW({ code: 'http_request.cache_into_plaintext', severity: 'warning', path: at + '.cacheInto', message: `Step ${step.id}: answers land as ordinary rows anyone with access to that table can read and export.`, hint: 'That is the point — you can check and correct them — but do not point this at a service whose answers should not be shared.' });
        }
    }
}

module.exports = { checkIntegrationAction, checkHttpRequest, checkAskOnce, checkCacheInto };
