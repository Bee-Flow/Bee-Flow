import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DYNAMIC_DEFAULT_BY_TYPE, RULES_BY_TYPE, withDynamicDefault, withRule, withoutRules } from './fieldRules';

/**
 * The table editor's field-rule helpers, and the pin that keeps their per-type
 * lists equal to what the server accepts (core/dataEngine/fieldRules.mts reads
 * the vocabulary; fieldRuleErrors refuses a rule on a type it does not fit).
 */

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '../../../../../../../server');
const vocabulary = require(path.join(SERVER, 'core/dataEngine/dataModel/vocabulary.js'));
const { fieldRuleErrors } = require(path.join(SERVER, 'core/dataEngine/fieldRules.mts'));

const SAMPLE: Record<string, unknown> = { min: 1, max: 2, minLength: 1, maxLength: 2, pattern: '^a', enforceOptions: true };

describe('field rule helpers', () => {
    it('a rule is set, and removed again without leaving an empty validation behind', () => {
        const base = { id: 'fld_a', key: 'qty', type: 'number' };
        const set = withRule(base, 'min', 1);
        expect(set).toEqual({ ...base, validation: { min: 1 } });
        expect(withRule(set, 'min', null)).toEqual(base);
        // A message alone checks nothing: it goes with the last rule.
        const withMessage = withRule(set, 'message', 'At least one.');
        expect(withRule(withMessage, 'min', null)).toEqual(base);
        expect(withRule({ ...base, type: 'select' }, 'enforceOptions', false)).toEqual({ ...base, type: 'select' });
    });

    it('a dynamic default replaces the static one and is removed with null; a type change drops every rule', () => {
        const day = { id: 'fld_d', key: 'day', type: 'date', default: '2026-01-01' };
        const dyn = withDynamicDefault(day, 'today');
        expect(dyn).toEqual({ id: 'fld_d', key: 'day', type: 'date', dynamicDefault: 'today' });
        expect(withDynamicDefault(dyn, null)).toEqual({ id: 'fld_d', key: 'day', type: 'date' });
        expect(withoutRules({ ...dyn, validation: { min: 1 } })).toEqual({ id: 'fld_d', key: 'day', type: 'date' });
    });
});

describe('the editor offers exactly what the server accepts', () => {
    it('every rule offered for a type passes the server check, and every other rule is refused there', () => {
        for (const type of vocabulary.FIELD_TYPES as string[]) {
            for (const key of vocabulary.FIELD_VALIDATION.keys as string[]) {
                if (key === 'message') continue;
                const errors = fieldRuleErrors({ key: 'f', type, options: ['a'], validation: { [key]: SAMPLE[key] } }, 'f');
                const offered = (RULES_BY_TYPE[type] || []).includes(key as never);
                expect(errors.length === 0, `${type}.${key}`).toBe(offered);
            }
        }
    });

    it('the dynamic default per type is the server list', () => {
        const server: Record<string, string> = {};
        for (const [value, types] of Object.entries(vocabulary.DYNAMIC_DEFAULTS.types as Record<string, string[]>)) {
            for (const type of types) server[type] = value;
        }
        expect(DYNAMIC_DEFAULT_BY_TYPE).toEqual(server);
    });
});
