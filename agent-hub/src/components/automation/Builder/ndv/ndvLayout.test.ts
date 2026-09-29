import { describe, expect, it } from 'vitest';
import {
    COL_MIN, INPUT_DEFAULT, INPUT_GROW_MAX, OUTPUT_DEFAULT, SETTINGS_MAX, SETTINGS_MIN,
    columnLayout, toggleSide, type ColumnLayoutInput,
} from './ndvLayout';

const base = (over: Partial<ColumnLayoutInput> = {}): ColumnLayoutInput => ({
    width: 0,
    inputOpen: true,
    outputOpen: true,
    narrowSide: 'input',
    inputW: INPUT_DEFAULT,
    outputW: OUTPUT_DEFAULT,
    inputSized: false,
    outputSized: false,
    ...over,
});
const settingsOf = (width: number, l: { inputPx: number; outputPx: number; showInput: boolean; showOutput: boolean }) =>
    width - (l.showInput ? l.inputPx : 0) - (l.showOutput ? l.outputPx : 0);

describe('columnLayout', () => {
    it('shows what was asked for, at the stored widths, until the drawer is measured', () => {
        expect(columnLayout(base())).toEqual({ showInput: true, showOutput: true, inputPx: 400, outputPx: 460, oneSide: false });
        expect(columnLayout(base({ inputOpen: false })).showInput).toBe(false);
    });

    it('shows one side column at a time on a laptop, the one last asked for', () => {
        for (const width of [1280, 1366, 1440]) {
            const l = columnLayout(base({ width }));
            expect(l.oneSide).toBe(true);
            expect([l.showInput, l.showOutput]).toEqual([true, false]);
            expect(settingsOf(width, l)).toBeGreaterThanOrEqual(SETTINGS_MIN);
            const out = columnLayout(base({ width, narrowSide: 'output' }));
            expect([out.showInput, out.showOutput]).toEqual([false, true]);
            expect(columnLayout(base({ width, narrowSide: 'none' }))).toMatchObject({ showInput: false, showOutput: false });
        }
    });

    it('shows all three columns once the settings keep their floor', () => {
        const l = columnLayout(base({ width: 1536 }));
        expect(l).toMatchObject({ showInput: true, showOutput: true, oneSide: false });
        expect(settingsOf(1536, l)).toBeGreaterThanOrEqual(SETTINGS_MIN);
    });

    it('on a wide screen caps the settings and gives the rest to the side columns, most to Continues on', () => {
        for (const width of [2560, 3440]) {
            const l = columnLayout(base({ width }));
            expect(settingsOf(width, l)).toBeLessThanOrEqual(SETTINGS_MAX);
            expect(l.inputPx).toBeLessThanOrEqual(INPUT_GROW_MAX);
            expect(l.outputPx).toBeGreaterThan(l.inputPx);
            expect(l.inputPx + l.outputPx + settingsOf(width, l)).toBe(width);
        }
    });

    it('keeps a dragged column at its width and lets the settings take what it leaves', () => {
        const l = columnLayout(base({ width: 3440, inputW: 500, inputSized: true, outputW: 700, outputSized: true }));
        expect([l.inputPx, l.outputPx]).toEqual([500, 700]);
    });

    it('never lets a lone side column push the settings under their floor', () => {
        const l = columnLayout(base({ width: 1280, inputOpen: false, outputW: 1200, outputSized: true }));
        expect(l.showOutput).toBe(true);
        expect(settingsOf(1280, l)).toBeGreaterThanOrEqual(SETTINGS_MIN);
        // A drawer too narrow for both floors still keeps the column usable.
        expect(columnLayout(base({ width: 700, inputOpen: false })).outputPx).toBe(COL_MIN);
    });
});

describe('toggleSide', () => {
    const narrow = { showInput: true, showOutput: false, oneSide: true };
    const wide = { showInput: true, showOutput: true, oneSide: false };
    const state = { inputOpen: true, outputOpen: true, narrowSide: 'input' as const };

    it('in the one-at-a-time mode swaps to a hidden column, and hides the shown one without revealing the other', () => {
        expect(toggleSide('output', state, narrow)).toEqual({ inputOpen: true, outputOpen: true, narrowSide: 'output' });
        expect(toggleSide('input', state, narrow)).toEqual({ inputOpen: true, outputOpen: true, narrowSide: 'none' });
    });

    it('with room for both, simply opens or closes that column', () => {
        expect(toggleSide('input', state, wide)).toEqual({ ...state, inputOpen: false });
        expect(toggleSide('output', { ...state, outputOpen: false }, { ...wide, showOutput: false }))
            .toEqual({ inputOpen: true, outputOpen: true, narrowSide: 'output' });
    });
});
