import { WEB_TOKENS } from '@/core/theme/generated/webTokens.generated';
import { PALETTES } from '@/core/theme/tokens';

import { KIND_KEYS, kindColor, kindOf, tileMetrics, tokenColor } from './kinds';

const dark = WEB_TOKENS.dark;
const theme = {
    colors: { ...PALETTES.dark, accentText: '', cardBorder: '', accentFill: '', accentFillFg: '' },
    stepType: dark.stepType,
    kind: dark.kind,
};

describe('kindOf', () => {
    it('accepts a key, an alias, any case and whitespace', () => {
        expect(kindOf('automation')).toBe('automation');
        expect(kindOf(' Knowledge_Base ')).toBe('kb');
        expect(kindOf('tables')).toBe('datatable');
    });

    it('reads kind, objectType, resourceType and type off an object, in that order', () => {
        expect(kindOf({ kind: 'form', type: 'app' })).toBe('form');
        expect(kindOf({ objectType: 'meeting_note' })).toBe('meeting');
        expect(kindOf({ resourceType: 'webpages' })).toBe('webpage');
        expect(kindOf({ type: 'assistant' })).toBe('agent');
    });

    it('answers null, never throws, for anything it does not know', () => {
        expect(kindOf(null)).toBeNull();
        expect(kindOf('')).toBeNull();
        expect(kindOf({ kind: 42 })).toBeNull();
        expect(kindOf('constructor')).toBeNull();
        expect(kindOf('__proto__')).toBeNull();
    });
});

describe('kindColor', () => {
    it('resolves each kind through the theme tokens the web names', () => {
        expect(kindColor(theme, 'automation')).toBe(dark.stepType.trigger);
        expect(kindColor(theme, 'agent')).toBe(dark.stepType.ai);
        expect(kindColor(theme, 'kb')).toBe(dark.kind.kb);
        expect(kindColor(theme, 'meeting')).toBe(dark.kind.meet);
        expect(kindColor(theme, 'solution')).toBe(dark.colors.textSecondary);
    });

    it('gives every kind a real colour, and no kind the neutral ink', () => {
        for (const key of KIND_KEYS) {
            expect([key, /^#|^rgb/.test(kindColor(theme, key))]).toEqual([key, true]);
        }
        expect(kindColor(theme, null)).toBe(dark.colors.textTertiary);
        expect(tokenColor(theme, '--type-nope')).toBe(dark.colors.textTertiary);
    });
});

describe('tileMetrics', () => {
    it('tints a small tile harder, and sizes the glyph like the web', () => {
        expect(tileMetrics('kb', 28)).toMatchObject({ tintPercent: 18, glyph: 15 });
        expect(tileMetrics('kb', 36)).toMatchObject({ tintPercent: 16, glyph: 18 });
        expect(tileMetrics('kb', 48, 20).tintPercent).toBe(20);
    });

    it('shapes an automation like a trigger and a form like a circle', () => {
        expect(tileMetrics('automation', 36).radius).toEqual({ topLeft: 18, topRight: 8, bottomRight: 8, bottomLeft: 18 });
        expect(tileMetrics('form', 30).radius.topLeft).toBe(15);
        expect(tileMetrics('app', 30).radius).toEqual({ topLeft: 8, topRight: 8, bottomRight: 8, bottomLeft: 8 });
    });
});
