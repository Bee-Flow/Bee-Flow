/**
 * App Studio canonicalizer — definition.variables, the declared shared values.
 */

'use strict';

const {
    LIMITS,
    VARIABLE_TYPES,
    VARIABLE_NAME_RE,
    RESERVED_VARIABLE_NAMES,
    coerceVariableDefault,
} = require('../componentSpecs');
const { isObject, deepCopy, truncate } = require('./shared');

/**
 * Turn `"my var"` into `my_var` — the same shape RolesManager slugifies a role
 * key into. One repair attempt before giving up, because a name with a space in
 * it is a typo, not a different feature; and a name a formula cannot read is
 * worth rescuing rather than dropping in silence.
 */
function slugVariableName(raw) {
    const slug = String(raw)
        .trim()
        .replace(/[^A-Za-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60);
    return /^[0-9]/.test(slug) ? `_${slug}`.slice(0, 60) : slug;
}

/**
 * definition.variables — the declared shared values. EMIT-WHEN-PRESENT: an app
 * with no variables key canonicalizes byte-identically to before this feature
 * existed, which is what keeps every shipped template's "no structural repairs"
 * contract and every frozen published definition intact.
 */
function cleanVariables(raw, push) {
    if (!Array.isArray(raw)) {
        if (raw !== undefined) {
            push('variables.invalid', 'variables', 'variables must be an array of { name, label, type, default, description } — dropped.');
        }
        return [];
    }

    let list = raw;
    if (list.length > LIMITS.MAX_VARIABLES) {
        push('variables.too_many', 'variables', `App declares ${list.length} variables — the maximum is ${LIMITS.MAX_VARIABLES}; the rest were dropped.`);
        list = list.slice(0, LIMITS.MAX_VARIABLES);
    }

    const out = [];
    const seen = new Set();
    list.forEach((variable, i) => {
        const path = `variables[${i}]`;
        if (!isObject(variable) || typeof variable.name !== 'string' || !variable.name.trim()) {
            push('variable.invalid', path, 'Each variable must be an object with a non-empty string name — dropped.');
            return;
        }

        let name = variable.name.trim();
        if (!VARIABLE_NAME_RE.test(name)) {
            const repaired = slugVariableName(name);
            if (!VARIABLE_NAME_RE.test(repaired)) {
                push('variable.name_invalid', `${path}.name`, `Variable name ${JSON.stringify(name)} cannot be read as vars.<name> — dropped.`);
                return;
            }
            push('variable.name_repaired', `${path}.name`, `Variable ${JSON.stringify(name)} renamed to ${JSON.stringify(repaired)} so a formula can read it.`);
            name = repaired;
        }
        if (RESERVED_VARIABLE_NAMES.includes(name)) {
            push('variable.name_reserved', `${path}.name`, `${JSON.stringify(name)} is reserved — dropped.`);
            return;
        }
        if (seen.has(name)) {
            push('variable.duplicate', path, `Duplicate variable ${JSON.stringify(name)} — dropped.`);
            return;
        }
        seen.add(name);

        let type = variable.type;
        if (!VARIABLE_TYPES.includes(type)) {
            if (type !== undefined) {
                push('variable.type_invalid', `${path}.type`, `Unknown variable type ${JSON.stringify(type)} — treated as "any".`);
            }
            type = 'any';
        }

        const { value, coerced } = coerceVariableDefault(type, deepCopy(variable.default));
        if (coerced && variable.default !== undefined) {
            push('variable.default_coerced', `${path}.default`, `Starting value for ${JSON.stringify(name)} adjusted to match its type (${type}).`);
        }

        const label = typeof variable.label === 'string' && variable.label.trim()
            ? truncate(variable.label, LIMITS.MAX_NAME_LEN, `${path}.label`, push)
            : name;
        const description = typeof variable.description === 'string'
            ? truncate(variable.description, 500, `${path}.description`, push)
            : '';

        // Fixed key order so canonical bytes are deterministic.
        out.push({ name, label, type, default: value, description });
    });
    return out;
}

module.exports = { slugVariableName, cleanVariables };
