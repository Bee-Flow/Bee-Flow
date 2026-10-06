/**
 * A flatten's output says its run in one sentence above the table (F49), and
 * a list read from a flatten's rows is counted in what the rows are (F47):
 * "Kept 8 of 64 attachments", not "items".
 */
import { render, screen, cleanup } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { FLATTEN_MAIL_STEP } from '@shared/expr/corpus.mjs';
import RunNote from './RunNote';
import { routeContextOf, routeNoteOf, routeSentence, routeUnit } from './routeNote';

const t = (_key: string, fallback?: unknown, vars?: Record<string, unknown>) =>
    String(fallback ?? '').replace(/\{(\w+)\}/g, (_, v) => String(vars?.[v] ?? ''));

const FILTER = { id: 'mf_filter', type: 'filter', arrayRef: 'steps.mf_flatten.output.items', expr: 'true' };
const definition = { steps: [{ ...FLATTEN_MAIL_STEP }, FILTER] };
const FLAT_OUT = { items: [{ filename: 'a.pdf' }], count: 64, inputCount: 4, emptyCount: 0 };

beforeEach(() => cleanup());

describe('route notes after a flatten', () => {
    it('routeUnit names a flatten\'s rows by its inner list when given the definition', () => {
        expect(routeUnit('steps.mf_flatten.output.items', t, definition)).toBe('attachments');
        expect(routeUnit('steps.mf_filter.output.items', t, definition)).toBe('attachments');
        expect(routeUnit('steps.mf_flatten.output.items', t)).toBe('items');
    });

    it('a filter after a flatten: "Kept 8 of 64 attachments"', () => {
        const route = routeContextOf(FILTER, t, definition)!;
        const note = routeNoteOf({ items: [], count: 8, inputCount: 64, rejectedCount: 56 }, route)!;
        expect(routeSentence(note, route.unit, t)).toBe('Kept 8 of 64 attachments');
    });

    it('a flatten output is its own note kind, never a "kept" one', () => {
        expect(routeNoteOf(FLAT_OUT)).toEqual({ kind: 'flatten', output: FLAT_OUT });
        expect(routeNoteOf({ items: [], count: 0 })).toBeNull();
    });

    it('routeContextOf carries the flatten step for its sentence', () => {
        const route = routeContextOf({ ...FLATTEN_MAIL_STEP }, t, definition)!;
        expect(route.flatten?.id).toBe('mf_flatten');
        expect(route.unit).toBe('attachments');
    });

    it('RunNote says "Made 64 rows from 4 messages."', () => {
        const route = routeContextOf({ ...FLATTEN_MAIL_STEP }, t, definition)!;
        render(<RunNote value={FLAT_OUT} route={route} />);
        expect(screen.getByTestId('output-route-note').textContent).toBe('Made 64 rows from 4 messages.');
    });
});
