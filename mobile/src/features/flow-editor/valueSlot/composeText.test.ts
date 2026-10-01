import { composeToText, markerFor, markersIn, plainText, textToCompose } from './composeText';

const name = { from: { root: 'trigger' as const, path: ['naam'] }, take: 'one' as const, as: 'text' as const };
const lines = { from: { root: 'steps' as const, id: 's1', path: ['orders', 'sku'] }, take: 'all' as const, as: 'text' as const, join: 'lines' as const, label: 'Producten', required: true };
const compose = { kind: 'compose' as const, v: 1 as const, parts: ['Beste ', name, ', uw orders:\n', lines] };

describe('composeText', () => {
    it('reads a compose into raw text with a marker per value, and back to the same compose', () => {
        const { raw, parts } = composeToText(compose);
        expect(raw).toBe(`Beste ${markerFor(0)}, uw orders:\n${markerFor(1)}`);
        expect(parts).toEqual([name, lines]);
        expect(textToCompose(raw, parts)).toEqual(compose);
    });

    it('keeps every key of a part (label, required) and the parts themselves', () => {
        const { raw, parts } = composeToText(compose);
        const back = textToCompose(raw, parts);
        expect(back?.parts[3]).toBe(lines);
    });

    it('drops a value whose marker is gone, and merges the text around it', () => {
        const { raw, parts } = composeToText(compose);
        const without = raw.replace(markerFor(0), '');
        expect(textToCompose(without, parts)).toEqual({ kind: 'compose', v: 1, parts: ['Beste , uw orders:\n', lines] });
    });

    it('gives null once no value is left, and the plain text then', () => {
        const { raw, parts } = composeToText(compose);
        const words = raw.replace(markerFor(0), '').replace(markerFor(1), '');
        expect(textToCompose(words, parts)).toBeNull();
        expect(plainText(raw)).toBe('Beste , uw orders:\n');
    });

    it('reads a marker that names no part as nothing', () => {
        expect(markersIn(`a${markerFor(5)}b`, [name])).toEqual([]);
        expect(textToCompose(`a${markerFor(5)}b`, [name])).toBeNull();
        expect(plainText(`a${markerFor(5)}b`)).toBe('ab');
    });

    it('a text part never turns into a value, whatever it holds', () => {
        const odd = { ...compose, parts: ['{{steps.s1.output.x}} 0', name] };
        const { raw, parts } = composeToText(odd);
        expect(markersIn(raw, parts)).toHaveLength(1);
        expect(textToCompose(raw, parts)?.parts[0]).toBe('{{steps.s1.output.x}} 0');
    });

    it('takes a value added at the end of the table', () => {
        const { raw, parts } = composeToText({ kind: 'compose', v: 1, parts: ['Hi '] });
        const next = [...parts, name];
        expect(textToCompose(`${raw}${markerFor(0)}!`, next)).toEqual({ kind: 'compose', v: 1, parts: ['Hi ', name, '!'] });
    });
});
