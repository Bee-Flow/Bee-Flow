/**
 * The organisation theme's choices are the web Theme Studio's: its presets and
 * fonts (appearance/ThemeContext.jsx), in its order, and its accent swatches
 * (studio/look/sections/AccentSection.jsx).
 */

import fs from 'node:fs';
import path from 'node:path';

import { ACCENT_PRESETS, FONT_IDS, THEME_PRESET_IDS } from './theme';

const WEB = path.resolve(__dirname, '../../../../../agent-hub/src/components/appearance');
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), 'utf8');

function idsOf(src: string, marker: string): string[] {
    const body = src.slice(src.indexOf(marker), src.indexOf('];', src.indexOf(marker)));
    return [...body.matchAll(/id: '([^']+)'/g)].map((m) => m[1] as string);
}

describe('the theme choices', () => {
    it('lists the web presets and fonts in the same order', () => {
        const src = read('ThemeContext.jsx');
        expect([...THEME_PRESET_IDS]).toEqual(idsOf(src, 'export const THEME_PRESETS'));
        expect([...FONT_IDS]).toEqual(idsOf(src, 'export const FONT_OPTIONS'));
    });

    it('offers the web accent swatches', () => {
        const src = read('studio/look/sections/AccentSection.jsx');
        const body = src.slice(src.indexOf('ACCENT_PRESETS'), src.indexOf('];'));
        expect([...ACCENT_PRESETS]).toEqual([...body.matchAll(/'(#[0-9a-f]{6})'/g)].map((m) => m[1]));
    });
});
