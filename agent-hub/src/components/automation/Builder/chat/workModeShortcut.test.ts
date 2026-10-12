import { describe, expect, it } from 'vitest';
import { isWorkModeShortcut, nextWorkMode } from './workModeShortcut';

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
    const modes = [{ id: 'discuss' }, { id: 'approve' }, { id: 'plan' }, { id: 'build' }];
    it('cycles and wraps', () => {
        expect(nextWorkMode(modes, 'discuss')).toBe('approve');
        expect(nextWorkMode(modes, 'build')).toBe('discuss');
        expect(nextWorkMode(modes, 'nonsense')).toBe('discuss');
    });
});
