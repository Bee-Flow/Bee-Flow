// @typecheck
'use strict';
/**
 * zod, with the default refusal texts of zod 3.
 *
 *   const { z } = require('../utils/zod');
 *
 * Every schema in the server answers a client through its message ("Required",
 * "String must contain at least 1 character(s)", ...), and part of those
 * sentences was never worded by hand: they are zod's own defaults. zod 4 words
 * its defaults differently ("Invalid input: expected string, received
 * undefined"), which would change what the client reads without a schema
 * changing. This module installs the zod 3 wording as zod's global fallback
 * (`customError`), which only speaks when a schema, a check or a parse call has
 * no message of its own. Messages written on a schema always win, as before.
 *
 * Load zod through here, not `require('zod')`, so the fallback is in place
 * wherever a schema is parsed. The table of texts is pinned, against the
 * zod 3 originals, in zod.test.js.
 */

const zod = require('zod');

/** zod 3's `getParsedType`: the word it used for what it received. */
function receivedType(v) {
    switch (typeof v) {
        case 'undefined': return 'undefined';
        case 'string': return 'string';
        case 'number': return Number.isNaN(v) ? 'nan' : 'number';
        case 'boolean': return 'boolean';
        case 'function': return 'function';
        case 'bigint': return 'bigint';
        case 'symbol': return 'symbol';
        case 'object':
            if (Array.isArray(v)) return 'array';
            if (v === null) return 'null';
            if (typeof v.then === 'function' && typeof v.catch === 'function') return 'promise';
            if (v instanceof Map) return 'map';
            if (v instanceof Set) return 'set';
            if (v instanceof Date) return 'date';
            return 'object';
        default: return 'unknown';
    }
}

/** zod 3's `joinValues`: strings quoted, the rest as they are. */
const joinValues = (values, sep = ' | ') => values.map((v) => (typeof v === 'string' ? `'${v}'` : v)).join(sep);

const jsonReplacer = (_key, value) => (typeof value === 'bigint' ? value.toString() : value);

// zod 4 format name -> the `validation` word zod 3 printed ("Invalid email").
const FORMAT_WORD = { ipv4: 'ip', ipv6: 'ip', cidrv4: 'cidr', cidrv6: 'cidr', guid: 'uuid' };

function sizeText(iss, small) {
    const bound = small ? iss.minimum : iss.maximum;
    const exact = iss.exact;
    const inclusive = iss.inclusive;
    switch (iss.origin) {
        case 'array':
            return `Array must contain ${exact ? 'exactly' : inclusive ? (small ? 'at least' : 'at most') : (small ? 'more than' : 'less than')} ${bound} element(s)`;
        case 'string':
            return `String must contain ${exact ? 'exactly' : inclusive ? (small ? 'at least' : 'at most') : (small ? 'over' : 'under')} ${bound} character(s)`;
        case 'number':
            return small
                ? `Number must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${bound}`
                : `Number must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${bound}`;
        case 'bigint':
            return small
                ? `Number must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${bound}`
                : `BigInt must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${bound}`;
        case 'date':
            return small
                ? `Date must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${new Date(Number(bound))}`
                : `Date must be ${exact ? 'exactly' : inclusive ? 'smaller than or equal to' : 'smaller than'} ${new Date(Number(bound))}`;
        default:
            return 'Invalid input';
    }
}

/** What zod 3 said for `iss`. Returns undefined for an issue it had no wording for. */
function zod3Text(iss) {
    switch (iss.code) {
        case 'invalid_type': {
            const received = receivedType(iss.input);
            if (received === 'undefined') return 'Required';
            if (iss.expected === 'int') return 'Expected integer, received float';
            const expected = iss.expected === 'record' ? 'object' : iss.expected === 'tuple' ? 'array' : iss.expected;
            return `Expected ${expected}, received ${received}`;
        }
        case 'invalid_value': {
            const type = iss.inst?._zod?.def?.type;
            if (type === 'enum') {
                if (typeof iss.input !== 'string') {
                    const received = receivedType(iss.input);
                    return received === 'undefined' ? 'Required' : `Expected ${joinValues(iss.values)}, received ${received}`;
                }
                return `Invalid enum value. Expected ${joinValues(iss.values)}, received '${iss.input}'`;
            }
            if (type === 'literal' && iss.values.length === 1) {
                return `Invalid literal value, expected ${JSON.stringify(iss.values[0], jsonReplacer)}`;
            }
            return undefined;
        }
        case 'unrecognized_keys':
            return `Unrecognized key(s) in object: ${joinValues(iss.keys, ', ')}`;
        case 'invalid_union':
            return iss.note === 'No matching discriminator' && Array.isArray(iss.options)
                ? `Invalid discriminator value. Expected ${joinValues(iss.options)}`
                : 'Invalid input';
        case 'invalid_format':
            if (iss.format === 'includes') {
                const text = `Invalid input: must include "${iss.includes}"`;
                return typeof iss.position === 'number' ? `${text} at one or more positions greater than or equal to ${iss.position}` : text;
            }
            if (iss.format === 'starts_with') return `Invalid input: must start with "${iss.prefix}"`;
            if (iss.format === 'ends_with') return `Invalid input: must end with "${iss.suffix}"`;
            if (iss.format === 'regex') return 'Invalid';
            return `Invalid ${FORMAT_WORD[iss.format] ?? iss.format}`;
        case 'too_small': return sizeText(iss, true);
        case 'too_big': return sizeText(iss, false);
        case 'not_multiple_of': return `Number must be a multiple of ${iss.divisor}`;
        case 'invalid_key': return iss.issues?.[0]?.message;
        case 'custom': return 'Invalid input';
        default: return undefined;
    }
}

zod.z.config({ customError: zod3Text });

/**
 * zod 3's `{ required_error, invalid_type_error }` as one `error` option:
 * `required` words a value that is missing, `invalid` a value of the wrong
 * type. Either may be left out (zod's own wording then speaks), and no other
 * issue of the schema is touched: a closed object still names its unknown
 * keys, an enum still lists its values.
 *
 *   z.object(shape, { error: typeError({ required: 'Send a body.', invalid: 'The body is an object.' }) })
 */
/** @param {{ required?: string, invalid?: string }} [messages] */
const typeError = ({ required, invalid } = {}) => (iss) => {
    if (iss.code !== 'invalid_type') return undefined;
    return iss.input === undefined ? required : invalid;
};

/**
 * The text for a closed object's unknown keys (zod 3's `.strict(message)`,
 * which zod 4 no longer takes), then `otherwise` for every other issue.
 */
const onUnknownKeys = (message, otherwise) => (iss) => (iss.code === 'unrecognized_keys' ? message : otherwise?.(iss));

/**
 * zod 3's `z.string().datetime({ offset: true })`, as a pattern for `.regex()`.
 * zod 4's own check takes only "+HH:MM" offsets; zod 3 also took "+HHMM" (and
 * any two digits as minutes), which clients and `new Date()` both read.
 */
const DATE_SOURCE = '((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))';
const datetimeWithOffset = new RegExp(`^${DATE_SOURCE}T([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(\\.\\d+)?)?(Z|([+-]\\d{2}:?\\d{2}))$`);

module.exports = { z: zod.z, zod3Text, typeError, onUnknownKeys, datetimeWithOffset };
