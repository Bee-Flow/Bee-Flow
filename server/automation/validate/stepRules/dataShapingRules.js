/**
 * The steps that reshape data in place rather than fetching or sending it:
 * the `code` escape hatch, the `layer_output` a layer returns, and the
 * n8n-style utility nodes `set` ("Edit data"), `parse_json` and `datetime`.
 *
 * Three of them share one convention worth knowing before reading the rules:
 * the PRESENCE of `arrayRef` switches the step into list mode, where it works
 * through a table row by row and the current row is `item`. Absent, the step
 * works on a single record.
 */

const { parseExpr } = require('../../expr');
const { isObject } = require('../helpers');
const { MAX_SET_OPERATIONS, validateSetOperation } = require('../setOperations');
const { checkMaxItems, checkReservedFieldNames } = require('../fieldChecks');
const {
    PARSE_JSON_FIELD_NAME_RE, PARSE_JSON_PATH_RE, MAX_PARSE_JSON_FIELDS,
    DATETIME_OPS, DATETIME_PARTS, DATETIME_DIFF_UNITS,
} = require('../constants');
const { impliedListMode } = require('../../datetimeListMode');

/**
 * What a code step's `limits` block may ask for — the authoring-side mirror of
 * `clampLimits` in automation/codeSandbox.js.
 *
 * THE CLAMP IS THE AUTHORITY. The sandbox is what actually constructs the
 * isolate, and its table is deliberate: code steps run IN-PROCESS, so an
 * oversized memoryMb/cpuMs/wallMs is a shared-host exhaustion vector — every
 * other tenant's runs on that pod slow down or OOM. This table is therefore
 * never allowed to be WIDER than the clamp. Narrower is fine (we insist on
 * whole numbers; clampLimits' tolerant `Number()` is a run-time last resort,
 * not a licence to store text), wider would be a promise the isolate never
 * keeps.
 *
 * It is a MIRROR rather than an import only because codeSandbox does not
 * export its table today — DEFAULT_LIMITS, MAX_LIMITS and HTTP_BUDGET_DEFAULT
 * are module-private, and requiring that module here would drag the
 * isolated-vm native load into every save. codeStepLimits.test.js reads
 * codeSandbox.js and fails, naming both numbers, the moment the two disagree;
 * that test is what stands in for the import. (builderPrompt.js already
 * carries a third, prose copy of these numbers in a comment — three copies is
 * exactly how a clamp table drifts, and the pin test covers that one too.)
 *
 * `what` and `unit` exist so a refusal can name the real bound in the author's
 * own terms instead of echoing a bare integer back at them.
 */
const CODE_LIMIT_BOUNDS = Object.freeze({
    memoryMb: { min: 8, max: 256, def: 64, unit: 'MB', what: 'isolate heap' },
    cpuMs: { min: 50, max: 10_000, def: 1000, unit: 'ms', what: 'V8 CPU time' },
    wallMs: { min: 100, max: 30_000, def: 5000, unit: 'ms', what: 'wall clock, ctx.http waits included' },
    httpBudget: { min: 0, max: 20, def: 5, unit: '', what: 'ctx.http calls per run' },
});

/**
 * Is `key` one of the four limits the sandbox actually reads?
 *
 * `CODE_LIMIT_BOUNDS[key]` looked like the obvious test and is not. Every
 * object inherits `constructor`, `toString`, `valueOf`, `hasOwnProperty`,
 * `isPrototypeOf` …, and `JSON.parse` cheerfully produces `{"constructor":
 * 9999}` out of an imported definition — so a limits block carrying one of
 * those names found a TRUTHY "bounds object" on Object.prototype, walked
 * straight past the unknown-key rule, and then compared 9999 against a `min`
 * and `max` of undefined, which is false in both directions. The key was
 * accepted and stored as a real own property of step.limits. The isolate
 * itself is unharmed (clampLimits reads its four by name), but the step then
 * claims to be configured for something it never gets — the exact thing
 * code.limits_unknown_key exists to say out loud — and a stored
 * `limits.hasOwnProperty = 9999` is worse than cosmetic: it turns any later
 * `step.limits.hasOwnProperty(…)` into a TypeError.
 *
 * dataSteps.js has carried SET_RESERVED_KEYS against this same family of
 * names since the `set` step shipped. This is that lesson, one table over:
 * ask whether the table OWNS the key, never whether the lookup was truthy.
 */
function isCodeLimitKey(key) {
    return Object.prototype.hasOwnProperty.call(CODE_LIMIT_BOUNDS, key);
}

/** "8..256 MB (isolate heap)" — one wording, used by every refusal below. */
function describeCodeLimit(key) {
    const b = CODE_LIMIT_BOUNDS[key];
    return `${b.min}..${b.max}${b.unit ? ` ${b.unit}` : ''} (${b.what})`;
}

function checkCode(ctx, step, at) {
    const { pushE, pushW, availableTools } = ctx;
    if (step.type === 'code') {
        if (!step.code || typeof step.code !== 'string') pushE({ code: 'code.code_missing', severity: 'error', path: at + '.code', message: `Step ${step.id}: code step requires \`code\`.`, hint: 'Provide the JS source as a string.' });
        if (step.language && step.language !== 'javascript') pushE({ code: 'code.language_unsupported', severity: 'error', path: at + '.language', message: `Step ${step.id}: only language: 'javascript' supported.`, hint: 'Either omit `language` or set it to "javascript".' });
        // What the code does, read without running it (automation/codeSafety,
        // pure: no isolated-vm). A BLOCK finding or a syntax error is an error
        // at activation, and a completeness code so a draft still saves: the
        // runner refuses the same code on every run anyway (codeStepGuard.js),
        // so switching it on would only produce failed runs.
        if (typeof step.code === 'string' && step.code.trim()) {
            const analysis = require('../../codeSafety').analyzeCode(step.code, { allowedTools: step.allowedTools || [], allowedHosts: step.allowedHosts || [] });
            if (!analysis.ok) {
                const se = analysis.syntaxError;
                pushE({ code: 'code.safety_blocked', severity: 'error', path: at + '.code', message: `Step ${step.id}: the code has a syntax error at line ${se.line}: ${se.message}`, hint: 'Fix the syntax error in the code editor.' });
            } else {
                const block = analysis.findings.find(f => f.severity === 'block');
                if (block) pushE({ code: 'code.safety_blocked', severity: 'error', path: at + '.code', message: `Step ${step.id}, line ${block.line}: ${block.message}`, hint: block.fix || 'Open the large code editor and fix the checks marked "cannot run".' });
            }
        }

        // ── limits ──────────────────────────────────────────────────
        // Nothing validated this until now, and applyAddCode hardcoded the
        // block, so the sandbox's clamp table was reachable by nobody: a step
        // that needed eight seconds of wall clock could not ask for it, and a
        // step that only ever shuffles ten rows could not give the rest back.
        // Now that the block is author-controllable, out-of-range has to be an
        // ERROR rather than a silent clamp. A step that asks for 512 MB and is
        // quietly handed 256 gives its author no way to find out: the run goes
        // green and the step is simply not what they think it is — the same
        // shape of failure as a credential that reads as empty.
        // These are INTEGRITY codes, not completeness ones (see
        // validate/completenessCodes.js): they block at draft stage too,
        // because an out-of-range ceiling is never "a field somebody has not
        // finished typing".
        if (step.limits !== undefined && step.limits !== null) {
            if (!isObject(step.limits)) {
                pushE({ code: 'code.limits_shape', severity: 'error', path: at + '.limits', message: `Step ${step.id}: code \`limits\` must be an object of resource limits.`, hint: `e.g. { ${Object.keys(CODE_LIMIT_BOUNDS).map(k => `${k}: ${CODE_LIMIT_BOUNDS[k].def}`).join(', ')} } — or omit it to take the defaults.` });
            } else {
                for (const [key, value] of Object.entries(step.limits)) {
                    const b = isCodeLimitKey(key) ? CODE_LIMIT_BOUNDS[key] : null;
                    if (!b) {
                        // A warning, not an error: the sandbox simply ignores
                        // the key, so nothing breaks and an imported routine
                        // must not be barred from activating over it. Worth
                        // saying all the same — a model reaching for this
                        // invents `timeoutMs`, `maxRows`, `retries`, and a
                        // field that LOOKS configured and does nothing is the
                        // worst kind of setting to leave in a saved step.
                        pushW({ code: 'code.limits_unknown_key', severity: 'warning', path: `${at}.limits.${key}`, message: `Step ${step.id}: limits.${key} is not a limit the sandbox reads — it does nothing.`, hint: `The sandbox honours ${Object.keys(CODE_LIMIT_BOUNDS).join(', ')} and ignores the rest. Remove it so the step does not look configured for something it never gets.` });
                        continue;
                    }
                    if (typeof value !== 'number' || !Number.isInteger(value)) {
                        pushE({ code: 'code.limits_not_a_number', severity: 'error', path: `${at}.limits.${key}`, message: `Step ${step.id}: limits.${key} must be a whole number (got ${JSON.stringify(value)}).`, hint: `Allowed range: ${describeCodeLimit(key)}. Default ${b.def}.` });
                        continue;
                    }
                    if (value < b.min || value > b.max) {
                        pushE({ code: 'code.limits_out_of_range', severity: 'error', path: `${at}.limits.${key}`, message: `Step ${step.id}: limits.${key} is ${value} — the sandbox allows ${describeCodeLimit(key)} and clamps anything outside that.`, hint: `Ask for ${value > b.max ? `${b.max} or less` : `${b.min} or more`}. Code steps run in-process, so this ceiling is what keeps one routine from starving every other run on the same host.` });
                    }
                }
            }
        }

        // ── inputs.secretKeys ───────────────────────────────────────
        // A code step that declares secretKeys can NEVER run: execCode
        // (core/automationRunner/execOutbound.js) throws on it outright,
        // because no secret store is wired to code steps in this build — the
        // codeSandbox.js header has the whole shape. Refusing it here is the
        // difference between finding out while you are authoring and finding
        // out when a scheduled routine fires at 03:00 and stops on its first
        // step.
        // Read EXACTLY the two shapes execCode reads — the binding form the
        // builder writes ({kind:'literal', value:[…]}) and the bare array a
        // hand-written or imported definition carries — or this check would
        // pass on the very shape that fails at run time.
        const declaredSecretKeys = Array.isArray(step.inputs?.secretKeys?.value) ? step.inputs.secretKeys.value
            : Array.isArray(step.inputs?.secretKeys) ? step.inputs.secretKeys
                : [];
        if (declaredSecretKeys.length > 0) {
            // Required lazily: codeSandbox pulls in the isolated-vm native
            // module, and this branch is the only thing in the validator that
            // needs it. The sentence is imported rather than restated because
            // that module's header says why there is exactly one wording for
            // it — "tests pin one string instead of two copies that drift
            // apart" — and this refusal is now its third reader.
            const { SECRETS_NOT_CONFIGURED_MESSAGE } = require('../../codeSandbox');
            pushE({ code: 'code.secret_keys_unsupported', severity: 'error', path: at + '.inputs.secretKeys', message: `Step ${step.id}: declares secretKeys (${declaredSecretKeys.join(', ')}), but ${SECRETS_NOT_CONFIGURED_MESSAGE}`, hint: 'Remove secretKeys and pass the value in through `inputs`, or reach the service with ctx.integrations.<tool>, which calls a connected app under its own credentials.' });
        }

        // ── allowedTools ────────────────────────────────────────────
        // The SHAPE is an error because of what execCode does with it:
        // `new Set(step.allowedTools || [])`. Hand that a bare string and it
        // becomes a set of CHARACTERS, so every ctx.integrations.<tool>() call
        // comes back "tool not allowed for this step" and nothing anywhere
        // says why the step that worked in the author's head calls nothing.
        if (step.allowedTools !== undefined && step.allowedTools !== null) {
            if (!Array.isArray(step.allowedTools) || step.allowedTools.some(t => typeof t !== 'string' || !t.trim())) {
                pushE({ code: 'code.allowed_tools_shape', severity: 'error', path: at + '.allowedTools', message: `Step ${step.id}: code \`allowedTools\` must be an array of tool names.`, hint: 'e.g. ["gmail_search"] — the tools this step may reach through ctx.integrations.<tool>(args). Use [] for code that calls none.' });
            } else if (availableTools) {
                // A WARNING, where integration_action.tool_unknown is an
                // error, for three reasons: allowedTools is a CEILING and not
                // a promise that the code calls it; execCode already
                // intersects it with the runner's CURRENT permission set, so
                // an unreachable name can only ever narrow what the step may
                // do; and the catalog seen while authoring is not necessarily
                // the catalog of whoever the routine ends up running as.
                for (const name of step.allowedTools) {
                    if (!availableTools.has(name)) pushW({ code: 'code.allowed_tool_unknown', severity: 'warning', path: at + '.allowedTools', message: `Step ${step.id}: allowedTools names "${name}", which is not in the catalog — ctx.integrations.${name}() will answer { error: 'tool "${name}" not allowed for this step' }.`, hint: 'Drop it, or ask for the integration that provides it to be connected.' });
                }
            }
        }
    }
}

function checkLayerOutput(ctx, step, at) {
    const { pushE, pushW } = ctx;
    // call_layer reference checks ran above (collectCallLayerSteps pass —
    // covers loop bodies / parallel branches too). Leftover denormalized
    // contract fields (inputContract/outputContract/version) are tolerated
    // and ignored.
    if (step.type === 'layer_output') {
        if (step.fields !== undefined && !isObject(step.fields)) pushE({ code: 'layer_output.fields_shape', severity: 'error', path: at + '.fields', message: `Step ${step.id}: layer_output.fields must be an object map of {key: binding}.`, hint: 'Use { result: { kind: "ref", path: "..." }, ... }.' });
        else if (isObject(step.fields)) checkReservedFieldNames(step, 'layer_output', at, pushE, pushW);
    }
}

function checkSet(ctx, step, at) {
    const { pushE, pushW } = ctx;
    // ── n8n-style utility nodes ───────────────────────────────────
    if (step.type === 'set') {
        // Set is "Edit data" — a binding map, optionally applied per row
        // of an upstream list (`arrayRef` present = list mode, the same
        // presence convention switch uses) plus whole-table `operations`.
        // An empty `fields` map IS allowed (degenerate but not invalid)
        // so we only check the shape of what's provided.
        if (step.fields !== undefined && !isObject(step.fields)) {
            pushE({ code: 'set.fields_shape', severity: 'error', path: at + '.fields', message: `Step ${step.id}: set.fields must be an object map of {key: binding}.`, hint: 'Use { name: { kind: "literal", value: "..." }, ... }.' });
        } else if (isObject(step.fields)) {
            checkReservedFieldNames(step, 'set', at, pushE, pushW);
            // A half-typed expr used to resolve to a silent undefined at
            // run time (resolveValue swallows the parse error). Surface it
            // like filter.expr_parse — in BOTH modes. Completeness code:
            // an expression is half-typed for as long as it takes to type
            // it, and autosave fires mid-keystroke.
            for (const [fkey, fb] of Object.entries(step.fields)) {
                if (isObject(fb) && fb.kind === 'expr' && typeof fb.value === 'string' && fb.value.trim()) {
                    try { parseExpr(fb.value); }
                    catch (e) { pushE({ code: 'set.field_expr_parse', severity: 'error', path: `${at}.fields.${fkey}`, message: `Step ${step.id}: field "${fkey}" expr parse error — ${e.message}`, hint: 'Restricted grammar only. Inside a list the current row is `item`.' }); }
                }
            }
        }
        const setListMode = typeof step.arrayRef === 'string';
        if (step.arrayRef !== undefined && !setListMode) {
            pushE({ code: 'set.arrayRef_type', severity: 'error', path: at + '.arrayRef', message: `Step ${step.id}: set \`arrayRef\` must be a path string.`, hint: 'Bind to an upstream array, e.g. `steps.<id>.output.items` — or remove the key to edit a single record.' });
        } else if (setListMode && step.arrayRef.trim() === '') {
            // In list mode but the source is still blank — same treatment
            // as switch/the collection ops: draft-saveable, blocks activation.
            pushE({ code: 'set.arrayRef_missing', severity: 'error', path: at + '.arrayRef', message: `Step ${step.id}: this step works through a list but no source list is set.`, hint: 'Bind to an upstream array, e.g. `steps.<id>.output.items`.' });
        }
        if (setListMode && step.forEach !== undefined && step.forEach !== null) {
            // Both would iterate: forEach wraps the WHOLE step per item
            // while list mode already runs the fields per row. The editor
            // never writes both; only raw API/AI authoring can.
            pushE({ code: 'set.foreach_conflict', severity: 'error', path: at + '.forEach', message: `Step ${step.id}: \`forEach\` and \`arrayRef\` (list mode) cannot be combined — both iterate.`, hint: 'Remove forEach; list mode already applies the fields to every row.' });
        }
        checkMaxItems(step, at, pushE, pushW);
        if (step.operations !== undefined) {
            if (!Array.isArray(step.operations)) {
                pushE({ code: 'set.operations_shape', severity: 'error', path: at + '.operations', message: `Step ${step.id}: set.operations must be an array of operation objects.`, hint: 'e.g. [{ op: "rowId", target: "id" }].' });
            } else {
                if (step.operations.length > 0 && !setListMode) {
                    pushE({ code: 'set.operations_without_list', severity: 'error', path: at + '.operations', message: `Step ${step.id}: table operations need a source list — the step is in single-record mode.`, hint: 'Set arrayRef to an upstream array, or remove the operations.' });
                }
                if (step.operations.length > MAX_SET_OPERATIONS) {
                    pushE({ code: 'set.operations_too_many', severity: 'error', path: at + '.operations', message: `Step ${step.id}: ${step.operations.length} operations — the maximum is ${MAX_SET_OPERATIONS}.`, hint: 'Split the work across two Edit data steps.' });
                }
                step.operations.forEach((o, oi) => validateSetOperation(step, o, oi, `${at}.operations[${oi}]`, pushE, pushW));
            }
        }
    }
}

function checkParseJson(ctx, step, at) {
    const { pushE, pushW, nested } = ctx;
    if (step.type === 'parse_json') {
        const aiMode = step.mode === 'ai';
        if (step.mode !== undefined && step.mode !== 'paths' && step.mode !== 'ai') {
            pushE({ code: 'parse_json.mode_invalid', severity: 'error', path: at + '.mode', message: `Step ${step.id}: parse_json.mode must be "paths" or "ai" (got "${step.mode}").`, hint: 'Use "paths" (deterministic, free) unless the payload shape varies run to run.' });
        }
        if (step.sourceRef !== undefined && step.sourceRef !== null && typeof step.sourceRef !== 'string') {
            pushE({ code: 'parse_json.source_ref_shape', severity: 'error', path: at + '.sourceRef', message: `Step ${step.id}: parse_json.sourceRef must be a string ref path.`, hint: 'e.g. "steps.<id>.output.body", or omit it to use the previous step\'s output.' });
        } else if (!step.sourceRef && nested) {
            // Inside a loop body / parallel branch the "previous step"
            // default CANNOT resolve: the runtime looks the predecessor up
            // in the ROOT definition's edges, and bodies have none — it
            // throws on every run. The old top-level warning let this
            // activate green (node-audit C5).
            pushE({ code: 'parse_json.source_required_here', severity: 'error', path: at + '.sourceRef', message: `Step ${step.id}: parse_json inside a loop body / parallel branch needs an explicit source.`, hint: 'Steps in a body have no wired predecessor — set Source explicitly, e.g. `loop.<itemVar>.body` or `steps.<id>.output.…`.' });
        } else if (!step.sourceRef) {
            pushW({ code: 'parse_json.source_defaulted', severity: 'warning', path: at + '.sourceRef', message: `Step ${step.id}: no sourceRef — uses the previous step's output.`, hint: 'Set sourceRef (e.g. "steps.<id>.output.body") to make the source explicit.' });
        }
        if (step.itemsRef !== undefined && step.itemsRef !== null && step.itemsRef !== '') {
            if (typeof step.itemsRef !== 'string' || !PARSE_JSON_PATH_RE.test(step.itemsRef)) {
                pushE({ code: 'parse_json.items_ref_invalid', severity: 'error', path: at + '.itemsRef', message: `Step ${step.id}: parse_json.itemsRef must be a path (relative to the source) pointing at a list.`, hint: 'e.g. "results" or "data.orders". Field paths are then relative to each item.' });
            }
        }
        if (step.fields !== undefined && !Array.isArray(step.fields)) {
            pushE({ code: 'parse_json.fields_shape', severity: 'error', path: at + '.fields', message: `Step ${step.id}: parse_json.fields must be an array of { name, path, description?, fallback? }.`, hint: 'e.g. [{ name: "customer_email", path: "order.customer.email" }].' });
        } else if (Array.isArray(step.fields) && step.fields.length > MAX_PARSE_JSON_FIELDS) {
            pushE({ code: 'parse_json.too_many_fields', severity: 'error', path: at + '.fields', message: `Step ${step.id}: parse_json has ${step.fields.length} fields — the maximum is ${MAX_PARSE_JSON_FIELDS}.`, hint: 'Split the extraction across two parse_json steps, or extract parent objects and bind their sub-fields downstream.' });
        } else if (!Array.isArray(step.fields) || step.fields.length === 0) {
            // Warning, not error — a freshly-dropped node must survive the
            // autosave round-trip before the user has added any fields.
            pushW({ code: 'parse_json.no_fields', severity: 'warning', path: at + '.fields', message: `Step ${step.id}: parse_json has no fields yet — its output will be empty.`, hint: 'Add at least one field (name + path) in the step settings.' });
        } else {
            const seenNames = new Set();
            step.fields.forEach((f, fi) => {
                const fat = at + `.fields[${fi}]`;
                if (!isObject(f) || typeof f.name !== 'string' || !PARSE_JSON_FIELD_NAME_RE.test(f.name) || f.name.length > 64) {
                    pushE({ code: 'parse_json.field_name_invalid', severity: 'error', path: fat + '.name', message: `Step ${step.id}: field ${fi} needs a valid name (letters/digits/underscore, not starting with a digit, max 64 chars).`, hint: 'Names become output keys — bind them downstream as steps.<id>.output.<name>.' });
                    return;
                }
                if (seenNames.has(f.name)) {
                    pushE({ code: 'parse_json.field_name_duplicate', severity: 'error', path: fat + '.name', message: `Step ${step.id}: duplicate field name "${f.name}".`, hint: 'Each field name must be unique.' });
                    return;
                }
                seenNames.add(f.name);
                if (!aiMode) {
                    const p = f.path;
                    const pathOk = p === '' || p === '$' || (typeof p === 'string' && PARSE_JSON_PATH_RE.test(p));
                    if (!pathOk) {
                        pushE({ code: 'parse_json.field_path_invalid', severity: 'error', path: fat + '.path', message: `Step ${step.id}: field "${f.name}" has an invalid path "${p}".`, hint: 'Paths are relative to the source: a.b, items[0].sku, items[*].sku (flatten), obj["key with spaces"]; "" or "$" = the whole source.' });
                    }
                } else if (typeof f.description !== 'string' || !f.description.trim()) {
                    pushE({ code: 'parse_json.field_description_missing', severity: 'error', path: fat + '.description', message: `Step ${step.id}: field "${f.name}" needs a description — in AI mode the description IS the extraction spec.`, hint: 'Describe the field in one sentence, e.g. "The customer\'s e-mail address".' });
                }
            });
        }
    }
}

function checkDatetime(ctx, step, at) {
    const { pushE, pushW } = ctx;
    if (step.type === 'datetime') {
        const op = step.op;
        if (!op || typeof op !== 'string') pushE({ code: 'datetime.op_missing', severity: 'error', path: at + '.op', message: `Step ${step.id}: datetime requires \`op\`.`, hint: `One of: ${Array.from(DATETIME_OPS).join(', ')}.` });
        else if (!DATETIME_OPS.has(op)) pushE({ code: 'datetime.op_unknown', severity: 'error', path: at + '.op', message: `Step ${step.id}: unknown datetime op "${op}".`, hint: `Use one of: ${Array.from(DATETIME_OPS).join(', ')}.` });
        // Per-op required fields.
        if (op === 'format' && !step.format) pushE({ code: 'datetime.format_missing', severity: 'error', path: at + '.format', message: `Step ${step.id}: datetime op "format" requires \`format\` string.`, hint: 'e.g. "yyyy-MM-dd HH:mm".' });
        if ((op === 'addDays' || op === 'addHours' || op === 'addMinutes') && typeof step.amount !== 'number') pushE({ code: 'datetime.amount_missing', severity: 'error', path: at + '.amount', message: `Step ${step.id}: datetime op "${op}" requires numeric \`amount\`.`, hint: 'Positive or negative integer.' });
        if (op === 'extract' && (!step.part || !DATETIME_PARTS.has(step.part))) pushE({ code: 'datetime.part_invalid', severity: 'error', path: at + '.part', message: `Step ${step.id}: datetime op "extract" requires \`part\` in ${Array.from(DATETIME_PARTS).join('/')}.`, hint: 'Pick one of the supported parts.' });
        if (op === 'diff' && (!step.unit || !DATETIME_DIFF_UNITS.has(step.unit))) pushE({ code: 'datetime.unit_invalid', severity: 'error', path: at + '.unit', message: `Step ${step.id}: datetime op "diff" requires \`unit\` in ${Array.from(DATETIME_DIFF_UNITS).join('/')}.`, hint: 'Pick the unit you want the difference reported in.' });
        // Every op except `now` reads an input date; `diff` reads two. An
        // empty input used to produce {iso:null, error:…} recorded as a
        // SUCCESS — the run went green while every downstream binding got
        // null (A17). The executor now throws; this catches it at
        // authoring time. Completeness-listed: warns at draft, blocks
        // activation. No resolvability check — literal dates are legal.
        if (op && op !== 'now' && DATETIME_OPS.has(op) && (typeof step.input !== 'string' || !step.input.trim())) {
            pushE({ code: 'datetime.input_missing', severity: 'error', path: at + '.input', message: `Step ${step.id}: datetime op "${op}" requires \`input\` (a date ref or literal).`, hint: 'Bind an upstream date (e.g. steps.<id>.output.receivedAt) or type a literal like 2026-08-01.' });
        }
        if (op === 'diff' && (typeof step.input2 !== 'string' || !step.input2.trim())) {
            pushE({ code: 'datetime.input2_missing', severity: 'error', path: at + '.input2', message: `Step ${step.id}: datetime op "diff" requires \`input2\` (the second date).`, hint: 'Bind the date to compare against, or type a literal.' });
        }
        // List mode, on the same `arrayRef` convention as set/switch/the
        // collection ops: work through a table and add a column, instead of
        // handing the whole column to one date parse (BFSF-375).
        const dtListMode = typeof step.arrayRef === 'string';
        if (step.arrayRef !== undefined && !dtListMode) {
            pushE({ code: 'datetime.arrayRef_type', severity: 'error', path: at + '.arrayRef', message: `Step ${step.id}: datetime \`arrayRef\` must be a path string.`, hint: 'Bind to an upstream list, e.g. `steps.<id>.output.results` — or remove the key to work on a single date.' });
        } else if (dtListMode && step.arrayRef.trim() === '') {
            pushE({ code: 'datetime.arrayRef_missing', severity: 'error', path: at + '.arrayRef', message: `Step ${step.id}: this step works through a list but no source list is set.`, hint: 'Bind to an upstream array, e.g. `steps.<id>.output.results`.' });
        }
        // A whole column in `input` with no `arrayRef`: saved before the
        // builder converted it, imported, or AI-written. The runner reads it
        // as the list mode it implies (automation/datetimeListMode.js), so
        // this is a warning that says what will happen and how to store it
        // that way — except for a list of lists, which no mode can read.
        if (op !== 'now' && step.arrayRef == null && typeof step.input === 'string' && step.input.includes('[*]')) {
            const implied = impliedListMode(step);
            if (implied) {
                pushW({ code: 'datetime.input_column', severity: 'warning', path: at + '.input', message: `Step ${step.id}: "${step.input}" is a whole column, so this step runs once per row of ${implied.arrayRef} and adds a column to each row.`, hint: `Store it as list mode: arrayRef "${implied.arrayRef}", input "${implied.input}" — or pick the column again in the editor.` });
            } else {
                pushW({ code: 'datetime.input_column', severity: 'warning', path: at + '.input', message: `Step ${step.id}: "${step.input}" is not one date or one column, so no date can be read from it.`, hint: 'Point it at one column of one list, e.g. steps.<id>.output.results[*].updated.' });
            }
        }
        if (step.target !== undefined && (typeof step.target !== 'string' || !step.target.trim())) {
            pushE({ code: 'datetime.target_invalid', severity: 'error', path: at + '.target', message: `Step ${step.id}: datetime \`target\` must be a non-empty column name.`, hint: 'Name the column the result goes into, e.g. "day" — or remove it to name it after the operation.' });
        }
        if (dtListMode && step.forEach !== undefined && step.forEach !== null) {
            // Both iterate: forEach wraps the WHOLE step per item while list
            // mode already runs the operation per row.
            pushE({ code: 'datetime.foreach_conflict', severity: 'error', path: at + '.forEach', message: `Step ${step.id}: \`forEach\` and \`arrayRef\` (list mode) cannot be combined — both iterate.`, hint: 'Remove forEach; list mode already applies the operation to every row.' });
        }
    }
}

module.exports = {
    checkCode, checkLayerOutput, checkSet, checkParseJson, checkDatetime,
    // Exported for the BUILDER: applyAddCode and builder_update_step's
    // normaliser refuse the same values this rule refuses, out of this one
    // table, so a step built by the AI and a step imported from JSON get the
    // same answer. builderTools already depends on validate (stepEditing and
    // half of stepBuilders require validate/constants); this is that same
    // one-way direction.
    CODE_LIMIT_BOUNDS, describeCodeLimit, isCodeLimitKey,
};
