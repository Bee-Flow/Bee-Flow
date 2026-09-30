/**
 * DIFFERENTIAL + TEXTUAL lockstep: the media option tables against the web's
 * constants/elevenLabsOptions.js (loaded and compared value for value) and
 * the arrays written into NanoBananaSettings.jsx and VideoGenSettings.jsx.
 */

import fs from 'node:fs';

import { AGENT_HUB_SRC, loadWebModule } from '@/shared/testing/webModule';

import * as catalog from './mediaCatalog';

type Option = { label: string; value: string | number };

const web = loadWebModule<{ TTS_MODELS: Option[]; TTS_VOICES: Option[]; DEFAULT_TTS_MODEL: string; DEFAULT_TTS_VOICE: string }>(
    'constants/elevenLabsOptions.js',
);

/** `const NAME = [ { label: 'x', value: y }, … ];` out of a component file, without its icons. */
function arrayIn(file: string, name: string): Option[] {
    const src = fs.readFileSync(`${AGENT_HUB_SRC}/components/chat/${file}`, 'utf8');
    const block = src.slice(src.indexOf(`const ${name} = [`));
    const body = block.slice(0, block.indexOf('];'));
    return [...body.matchAll(/label: '([^']+)', value: ('([^']+)'|(\d+))/g)].map((m) => ({
        label: m[1] as string,
        value: m[3] !== undefined ? m[3] : Number(m[4]),
    }));
}

/** The phone's `name` is the web's `label`. */
const asWeb = (options: readonly catalog.MediaOption[]): Option[] => options.map(({ name, value }) => ({ label: name, value }));

it('offers the web’s voices and speech models, with the same defaults', () => {
    expect(asWeb(catalog.TTS_MODELS)).toEqual(web.TTS_MODELS);
    expect(asWeb(catalog.TTS_VOICES)).toEqual(web.TTS_VOICES);
    expect(catalog.DEFAULT_TTS_MODEL).toBe(web.DEFAULT_TTS_MODEL);
    expect(catalog.DEFAULT_TTS_VOICE).toBe(web.DEFAULT_TTS_VOICE);
});

it('offers the web’s image and video choices', () => {
    expect(asWeb(catalog.IMAGE_ASPECT_RATIOS)).toEqual(arrayIn('NanoBananaSettings.jsx', 'ASPECT_RATIOS'));
    expect(asWeb(catalog.IMAGE_MODELS)).toEqual(arrayIn('NanoBananaSettings.jsx', 'IMAGE_MODELS'));
    expect(asWeb(catalog.VIDEO_MODELS)).toEqual(arrayIn('VideoGenSettings.jsx', 'VIDEO_MODELS'));
    expect(asWeb(catalog.VIDEO_ASPECT_RATIOS)).toEqual(arrayIn('VideoGenSettings.jsx', 'ASPECT_RATIOS'));
    expect(asWeb(catalog.VIDEO_DURATIONS)).toEqual(arrayIn('VideoGenSettings.jsx', 'DURATIONS'));
});

it('translates the Lyria modes with the web’s own words', () => {
    const src = fs.readFileSync(`${AGENT_HUB_SRC}/components/chat/MusicGenSettings.jsx`, 'utf8');
    for (const mode of catalog.LYRIA_MODES) expect(src).toContain(`t('${mode.i18nKey}', '${mode.name}')`);
});

it('gates each generator on the integration and key the web checks', () => {
    const src = fs.readFileSync(`${AGENT_HUB_SRC}/components/chat/InputArea/index.jsx`, 'utf8');
    const gates: Record<string, { integration: string; key: string }> = {};
    for (const m of src.matchAll(/const show(\w+) = externalToolsOk && orgOn\('([^']+)'\) && has(\w+)Key;/g)) {
        gates[m[2] as string] = { integration: m[2] as string, key: (m[3] as string).toLowerCase() };
    }
    const mine = Object.values(catalog.MEDIA_GATES).map((g) => ({ integration: g.integration, key: g.key }));
    expect(mine.sort((a, b) => a.integration.localeCompare(b.integration))).toEqual(
        Object.values(gates).sort((a, b) => a.integration.localeCompare(b.integration)),
    );
});
