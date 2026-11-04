import { describe, expect, it } from 'vitest';
import { isWorkModeShortcut, nextWorkMode } from './workModeShortcut';
import { WORK_MODES } from './WorkModePicker';

const ev = (over: Record<string, unknown>) => ({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...over });

describe('isWorkModeShortcut', () => {
    it('is Alt+M on the physical key, also where Alt turns M into another character', () => {
        expect(isWorkModeShortcut(ev({ altKey: true, code: 'KeyM', key: 'µ' }))).toBe(true);
        expect(isWorkModeShortcut(ev({ altKey: true, key: 'm' }))).toBe(true);
    });

    it('leaves Shift+Tab and every other key alone', () => {
        expect(isWorkModeShortcut(ev({ shiftKey: true, code: 'Tab', key: 'Tab' }))).toBe(false);
        expect(isWorkModeShortcut(ev({ code: 'KeyM', key: 'm' }))).toBe(false);
        expect(isWorkModeShortcut(ev({ altKey: true, shiftKey: true, code: 'KeyM' }))).toBe(false);
        expect(isWorkModeShortcut(ev({ altKey: true, ctrlKey: true, code: 'KeyM' }))).toBe(false);
        expect(isWorkModeShortcut(ev({ altKey: true, code: 'KeyN' }))).toBe(false);
    });
});

describe('nextWorkMode', () => {
    const modes = [{ id: 'describe' }, { id: 'discuss' }, { id: 'approve' }, { id: 'plan' }, { id: 'build' }];
    it('cycles and wraps', () => {
        expect(nextWorkMode(modes, 'describe')).toBe('discuss');
        expect(nextWorkMode(modes, 'discuss')).toBe('approve');
        expect(nextWorkMode(modes, 'build')).toBe('describe');
        expect(nextWorkMode(modes, 'nonsense')).toBe('describe');
    });

    it('Alt+M cycles through every mode of the picker, "Describe it" first', () => {
        expect(WORK_MODES.map(m => m.id)).toEqual(['describe', 'discuss', 'approve', 'plan', 'build']);
        const seen = [WORK_MODES[0].id];
        while (seen.length < WORK_MODES.length) seen.push(nextWorkMode(WORK_MODES, seen[seen.length - 1]));
        expect(nextWorkMode(WORK_MODES, seen[seen.length - 1])).toBe('describe');
        expect(new Set(seen).size).toBe(WORK_MODES.length);
    });
});
