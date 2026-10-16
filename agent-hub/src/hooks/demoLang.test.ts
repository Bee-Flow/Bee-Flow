import { describe, it, expect } from 'vitest';
import { demoLangOverride } from './demoLang';

describe('demoLangOverride', () => {
    it('reads a valid ?lang= on a demo path', () => {
        expect(demoLangOverride('/__demo__/automations', '?theme=light&lang=nl')).toBe('nl');
        expect(demoLangOverride('/__demo__/automations/', '?lang=NL-be')).toBe('nl');
    });

    it('ignores lang outside a demo path, and malformed values', () => {
        expect(demoLangOverride('/app', '?lang=nl')).toBeNull();
        expect(demoLangOverride('/__demo__/automations', '?lang=../x')).toBeNull();
        expect(demoLangOverride('/__demo__/automations', '')).toBeNull();
    });
});
