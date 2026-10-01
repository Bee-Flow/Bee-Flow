/**
 * The checks on the v2 mapping a step carries: pick and compose bindings, the
 * per-item `step.repeat`, and a loop's `over`.
 *
 * Every place a step keeps a value comes from the shared core's
 * stepBindingSites (shared/mapping/sites.mjs), so a field added to a step type
 * there is checked here without a second list. What is checked:
 *
 *   mapping.invalid           a binding that says it is v2 (`v: 1`) but whose
 *                             structure does not validate. The run gives it no
 *                             value, so this is an ERROR.
 *   mapping.unversioned       `kind: 'pick' | 'compose'` without `v`: the run
 *                             treats it as plain data (a literal), as it did
 *                             before v2 existed. Warning.
 *   mapping.compose_unsupported  a compose in a text field whose executor
 *                             still reads only a plain string. Error.
 *   mapping.unknown_step      a pick of a step that does not exist. Error.
 *   mapping.forward           a pick of a step that has not run by then. Warning.
 *   mapping.loop_unbound      a pick of `loop.<var>` nothing binds here. Error.
 *   mapping.each_outside_repeat  a pick of "the current item" in a step that
 *                             does not repeat over that list. Error.
 *   mapping.unknown_field     the first field is not one the source produces.
 *                             Warning, with the closest field as the fix.
 *   repeat.*                  the shape of step.repeat (over, max, which step
 *                             types may repeat, not beside list mode).
 *
 * The legacy kinds are referenceScoping.js's; nothing here changes what a
 * stored legacy binding validates to.
 */

const { isObject } = require('../helpers');
const { FOREACH_ALLOWED } = require('./iterationRules');
const {
    stepBindingSites, isPick, isCompose, pickProblems, composeProblems, sourceProblems,
    describeSource, mappingIssues, MAPPING_VERSION,
} = require('../../../shared/mapping/index.mjs');

const LEGACY_KINDS = new Set(['literal', 'ref', 'template', 'expr']);
const MAX_FIELDS_NAMED = 12;

/** What to call a pick in a message: its label, else its path. */
function nameOf(pick) {
    return typeof pick.label === 'string' && pick.label ? `"${pick.label}" (${describeSource(pick.from)})` : `"${describeSource(pick.from)}"`;
}

/**
 * Every v2-looking binding in a value: valid picks and composes, and the
 * objects that say `kind: 'pick' | 'compose'` but are not valid ones.
 * Legacy wrappers are not descended into (a literal's value is data).
 */
function collectMappings(value, out, depth = 0) {
    if (value === null || typeof value !== 'object' || depth > 32) return;
    if (Array.isArray(value)) { for (const v of value) collectMappings(v, out, depth + 1); return; }
    if (typeof value.kind === 'string') {
        if (value.kind === 'pick' || value.kind === 'compose') { out.push(value); return; }
        if (LEGACY_KINDS.has(value.kind)) return;
    }
    for (const k of Object.keys(value)) collectMappings(value[k], out, depth + 1);
}

function checkSource(ctx, step, at, source, what) {
    const { pushE, pushW, refIds, refSeen, loopVarsAbove } = ctx;
    if (source.root === 'steps') {
        if (!refIds.has(source.id) && source.id !== step.id) {
            pushE({
                code: 'mapping.unknown_step', severity: 'error', path: at,
                message: `Step ${step.id}: ${what} reads step "${source.id}", which does not exist.`,
                hint: 'Pick the value again from a step that is in this routine.',
            });
            return false;
        }
        if (!refSeen.has(source.id) && source.id !== step.id) {
            pushW({
                code: 'mapping.forward', severity: 'warning', path: at,
                message: `Step ${step.id}: ${what} reads step "${source.id}", which has not run by then, so it is empty.`,
                hint: `Wire an edge from "${source.id}" to "${step.id}" so its output is there.`,
            });
        }
    }
    if (source.root === 'loop') {
        const own = isObject(step.forEach) && typeof step.forEach.itemVar === 'string' ? step.forEach.itemVar : null;
        const above = loopVarsAbove.get(step) || [];
        if (source.id !== own && !above.includes(source.id)) {
            pushE({
                code: 'mapping.loop_unbound', severity: 'error', path: at,
                message: `Step ${step.id}: ${what} reads the loop item "${source.id}", but nothing binds it for this step.`,
                hint: 'Pick the value from the list itself, or put this step inside the loop that goes through it.',
            });
            return false;
        }
    }
    return true;
}

function checkPick(ctx, step, at, pick, repeatOver) {
    if (!checkSource(ctx, step, at, pick.from, `the value ${nameOf(pick)}`)) return;
    for (const issue of mappingIssues({ ...pick, kind: 'pick', v: MAPPING_VERSION }, { fieldsOf: ctx.fieldsOf, repeatOver })) {
        if (issue.code === 'each_outside_repeat') {
            ctx.pushE({
                code: 'mapping.each_outside_repeat', severity: 'error', path: at,
                message: `Step ${step.id}: ${nameOf(pick)} reads the current item of a list, but this step does not run once per item of it.`,
                hint: repeatOver
                    ? `This step repeats over "${describeSource(repeatOver)}". Pick the value from that list, or take all of it.`
                    : 'Turn on "run once per item" for that list in the step\'s advanced settings, or take all of it.',
            });
        } else if (issue.code === 'unknown_field') {
            const known = issue.known.length > MAX_FIELDS_NAMED ? `${issue.known.slice(0, MAX_FIELDS_NAMED).join(', ')}, …` : issue.known.join(', ');
            ctx.pushW({
                code: 'mapping.unknown_field', severity: 'warning', path: at,
                ...(issue.fix ? { fix: { from: issue.path, to: issue.fix } } : {}),
                message: `Step ${step.id}: ${nameOf(pick)} reads "${issue.field}", which its source does not produce (it has: ${known}).`,
                hint: issue.fix ? `Did you mean "${issue.fix}"?` : 'Pick one of the fields the source produces.',
            });
        }
    }
}

function checkMapping(ctx, step, at, binding, repeatOver, site) {
    const { pushE, pushW } = ctx;
    if (binding.v === undefined) {
        pushW({
            code: 'mapping.unversioned', severity: 'warning', path: at,
            message: `Step ${step.id}: a "${binding.kind}" object without a version in ${site.field} is sent as it is, not resolved.`,
            hint: `Give it "v": ${MAPPING_VERSION} to have it resolved, or wrap it as {"kind":"literal","value":…} if it is data.`,
        });
        return;
    }
    const problems = binding.kind === 'pick' ? pickProblems(binding) : composeProblems(binding);
    if (problems.length) {
        pushE({
            code: 'mapping.invalid', severity: 'error', path: at,
            message: `Step ${step.id}: the ${binding.kind} binding in ${site.field} is not valid (${problems.join(', ')}), so it gives no value.`,
            hint: 'Pick the value again.',
        });
        return;
    }
    if (binding.kind === 'compose' && site.kind === 'text' && site.compose === false) {
        pushE({
            code: 'mapping.compose_unsupported', severity: 'error', path: at,
            message: `Step ${step.id}: ${site.field} takes plain text with {{ }} placeholders only; a text with picked values there renders as nothing.`,
            hint: 'Write the text with placeholders for this field.',
        });
        return;
    }
    if (isPick(binding)) checkPick(ctx, step, at, binding, repeatOver);
    else if (isCompose(binding)) for (const part of binding.parts) if (typeof part !== 'string') checkPick(ctx, step, at, part, repeatOver);
}

function checkRepeat(ctx, step, at) {
    const { pushE, pushW } = ctx;
    const rep = step.repeat;
    if (!isObject(rep)) {
        pushE({ code: 'repeat.shape', severity: 'error', path: at + '.repeat', message: `Step ${step.id}: repeat must be an object { over, max }.`, hint: 'Turn "run once per item" off and on again.' });
        return null;
    }
    if (!FOREACH_ALLOWED.has(step.type)) {
        pushE({ code: 'repeat.type_unsupported', severity: 'error', path: at + '.repeat', message: `Step ${step.id}: "${step.type}" steps cannot run once per item.`, hint: `Only ${[...FOREACH_ALLOWED].join(' / ')} can. Use a loop step instead.` });
    }
    if (sourceProblems(rep.over).length) {
        pushE({ code: 'repeat.over_invalid', severity: 'error', path: at + '.repeat.over', message: `Step ${step.id}: the list this step runs once per item of is not set, or not valid.`, hint: 'Pick the list again in the step\'s advanced settings.' });
        return null;
    }
    if (rep.max !== undefined && (!Number.isSafeInteger(rep.max) || rep.max < 1 || rep.max > 1000)) {
        pushE({ code: 'repeat.max_range', severity: 'error', path: at + '.repeat.max', message: `Step ${step.id}: the most items to run for must be 1..1000.`, hint: '100 is a sensible default.' });
    }
    if (step.forEach !== undefined && step.forEach !== null) {
        pushW({ code: 'repeat.with_for_each', severity: 'warning', path: at + '.forEach', message: `Step ${step.id}: it has both a repeat and an older "run once per item" (forEach); only the repeat is used.`, hint: 'Remove the forEach.' });
    }
    // List mode already applies the step to every row; a repeat on top would
    // run that whole list once per item.
    if ((step.type === 'set' || step.type === 'datetime') && typeof step.arrayRef === 'string' && step.arrayRef) {
        pushE({ code: 'repeat.with_list_mode', severity: 'error', path: at + '.repeat', message: `Step ${step.id}: list mode and "run once per item" cannot be combined.`, hint: 'Turn one of them off.' });
    }
    checkSource(ctx, step, at + '.repeat.over', rep.over, `the list it runs once per item of ("${describeSource(rep.over)}")`);
    return rep.over;
}

function checkMappings(ctx, step, at) {
    if (!isObject(step)) return;
    const repeatOver = step.repeat !== undefined && step.repeat !== null ? checkRepeat(ctx, step, at) : null;
    for (const site of stepBindingSites(step)) {
        if (site.field === 'repeat.over') continue;
        if (site.kind === 'list' && site.field === 'over' && step.type === 'loop') {
            const over = isPick(site.value) ? site.value.from : site.value;
            if (sourceProblems(over).length) {
                ctx.pushE({ code: 'loop.over_invalid', severity: 'error', path: at + '.over', message: `Step ${step.id}: the list this loop goes through is not valid.`, hint: 'Pick the list again.' });
            } else {
                checkSource(ctx, step, at + '.over', over, `the list it loops over ("${describeSource(over)}")`);
            }
            continue;
        }
        const found = [];
        collectMappings(site.value, found);
        for (const binding of found) checkMapping(ctx, step, at, binding, repeatOver, site);
    }
}

module.exports = { checkMappings };
