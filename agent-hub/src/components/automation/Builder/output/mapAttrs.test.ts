// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { MouseEvent } from 'react';
import { WILD, walkPath } from '@shared/mapping/index.mjs';
import { childMap, colSegments, mapAttrs, pickTarget, type MapCtx } from './mapAttrs';

/**
 * The output view's click/drag-to-map paths. Regression: a column called
 * `Order date` or `first-name` used to be appended raw (`rows[*].Order date`),
 * which the preview resolved and the run rejected, so the step got nothing.
 */
const ROWS = [{ 'Order date': '2026-01-01', 'first-name': 'Jan', meta: { 'zip code': '1234' } }, { 'Order date': '2026-02-01', 'first-name': 'Piet' }];
const ROOT = { steps: { s: { output: { rows: ROWS } } } };
const map = (onPick: MapCtx['onPick'] = null): MapCtx => ({ path: 'steps.s.output.rows', onPick });

describe('mapAttrs / pickTarget', () => {
    it('quotes a column key that is not an identifier, and the run resolves it', () => {
        const t = pickTarget(map(), [WILD, 'Order date']);
        expect(t?.path).toBe('steps.s.output.rows[*]["Order date"]');
        expect(walkPath(t?.path, ROOT)).toEqual(['2026-01-01', '2026-02-01']);
        expect(pickTarget(map(), [1, 'first-name'])?.path).toBe('steps.s.output.rows[1]["first-name"]');
        expect(walkPath(pickTarget(map(), [1, 'first-name'])?.path, ROOT)).toBe('Piet');
    });

    it('carries the Source beside the path', () => {
        expect(pickTarget(map(), [WILD, 'Order date'])?.source).toEqual({ root: 'steps', id: 's', path: ['rows', WILD, 'Order date'] });
        expect(pickTarget({ path: 'not a path' }, ['x'])?.source).toBeNull();
    });

    it('offers nothing for a key the grammar cannot write', () => {
        expect(pickTarget(map(), [WILD, 'a]b'])).toBeNull();
        expect(mapAttrs(map(), [WILD, 'a]b'])).toEqual({});
        expect(childMap(map(), ['a]b'])).toBeNull();
    });

    it('hands the escaped path and its Source to onPick', () => {
        const onPick = vi.fn();
        const attrs = mapAttrs(map(onPick), [0, ...colSegments('meta.zip code')]);
        attrs.onClick?.({ stopPropagation() {}, altKey: false } as unknown as MouseEvent<HTMLElement>);
        expect(onPick).toHaveBeenCalledWith('steps.s.output.rows[0].meta["zip code"]', {
            raw: false,
            source: { root: 'steps', id: 's', path: ['rows', 0, 'meta', 'zip code'] },
        });
    });

    it('childMap descends with the same rule', () => {
        const child = childMap(map(), [0, 'first-name']);
        expect(child?.path).toBe('steps.s.output.rows[0]["first-name"]');
        expect(walkPath(child?.path, ROOT)).toBe('Jan');
    });
});

describe('colSegments', () => {
    it('reads the table\'s dotted column ids', () => {
        expect(colSegments('Order date')).toEqual(['Order date']);
        expect(colSegments('output.content')).toEqual(['output', 'content']);
        expect(colSegments('attachments[*].name')).toEqual(['attachments', WILD, 'name']);
    });
});
