import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DATE_STYLES, DISPLAY_BY_TYPE, TEXT_FORMATS, withDisplay, withFormat, withTypeShape } from './fieldDisplay';

/**
 * The table editor's format and display helpers, and the pin that keeps their per-type lists equal
 * to what the server accepts (core/dataEngine/fieldFormats.mts fieldShapeErrors).
 */

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '../../../../../../../server');
const vocabulary = require(path.join(SERVER, 'core/dataEngine/dataModel/vocabulary.js'));
const { fieldShapeErrors } = require(path.join(SERVER, 'core/dataEngine/fieldFormats.mts'));

const SAMPLE: Record<string, unknown> = { currency: 'EUR', decimals: 2, unit: 'kg', dateStyle: 'long' };

describe('field display helpers', () => {
    it('a display key is set, removed again without leaving an empty display, and currency and unit exclude each other', () => {
        const base = { id: 'fld_a', key: 'price', type: 'number' };
        const set = withDisplay(base, 'currency', 'EUR');
        expect(set).toEqual({ ...base, display: { currency: 'EUR' } });
        expect(withDisplay(set, 'currency', null)).toEqual(base);
        expect(withDisplay(set, 'unit', 'kg')).toEqual({ ...base, display: { unit: 'kg' } });
        expect(withDisplay(withDisplay(set, 'decimals', 2), 'decimals', null)).toEqual(set);
    });

    it('a format is set and removed; a type change drops format and display; an autonumber is unique, not required, without default', () => {
        const text = { id: 'fld_t', key: 'mail', type: 'text' };
        expect(withFormat(text, 'email')).toEqual({ ...text, format: 'email' });
        expect(withFormat({ ...text, format: 'email' }, null)).toEqual(text);
        expect(withTypeShape({ ...text, format: 'email', display: { unit: 'x' } }, 'number')).toEqual(text);
        expect(withTypeShape({ ...text, required: true, default: 'a' }, 'autonumber')).toEqual({ ...text, required: false, unique: true });
    });
});

describe('the editor offers exactly what the server accepts', () => {
    it('the text formats and date styles are the server lists', () => {
        expect([...TEXT_FORMATS]).toEqual([...vocabulary.TEXT_FORMATS.values]);
        expect([...DATE_STYLES]).toEqual([...vocabulary.FIELD_DISPLAY.dateStyles]);
    });

    it('every display key offered for a type passes the server check, and every other key is refused there', () => {
        for (const type of vocabulary.FIELD_TYPES as string[]) {
            if (type === 'autonumber') continue; // its own rule (always unique) is pinned by the server test
            for (const key of vocabulary.FIELD_DISPLAY.keys as string[]) {
                const errors = fieldShapeErrors({ key: 'f', type, display: { [key]: SAMPLE[key] } }, 'f');
                const offered = (DISPLAY_BY_TYPE[type] || []).includes(key as never);
                expect(errors.length === 0, `${type}.${key}`).toBe(offered);
            }
        }
    });
});
