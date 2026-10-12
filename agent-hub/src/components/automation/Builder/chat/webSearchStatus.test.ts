import { describe, it, expect } from 'vitest';
import { webSearchUnavailableHint } from './webSearchStatus';

const t = (_key: string, en: string) => en;

describe('webSearchUnavailableHint', () => {
    it('is null before any turn reported, when the user switched it off, and when it worked', () => {
        expect(webSearchUnavailableHint(null, t)).toBeNull();
        expect(webSearchUnavailableHint({ requested: false, available: false, reason: 'off' }, t)).toBeNull();
        expect(webSearchUnavailableHint({ requested: true, available: true, reason: null }, t)).toBeNull();
    });

    it('names the reason the server refused a switch that was on', () => {
        expect(webSearchUnavailableHint({ requested: true, available: false, reason: 'not_configured' }, t)).toMatch(/not set up/);
        expect(webSearchUnavailableHint({ requested: true, available: false, reason: 'not_permitted' }, t)).toMatch(/not enabled/);
        expect(webSearchUnavailableHint({ requested: true, available: false, reason: 'upload_policy' }, t)).toMatch(/files attached/);
        expect(webSearchUnavailableHint({ requested: true, available: false, reason: 'something new' }, t)).toMatch(/could not be checked/);
    });
});
