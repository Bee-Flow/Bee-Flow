/**
 * TEXTUAL lockstep: every setting the phone's media panel writes is one the
 * web's panels write, under the same key, with the same default.
 */

import fs from 'node:fs';

import { AGENT_HUB_SRC } from '@/shared/testing/webModule';

import { controlValue, MEDIA_PANELS, panelsFor } from './mediaPanels';

const read = (name: string) => fs.readFileSync(`${AGENT_HUB_SRC}/components/chat/${name}`, 'utf8');
const WEB = {
    image: read('NanoBananaSettings.jsx') + read('ImageGenSettings.jsx'),
    video: read('VideoGenSettings.jsx'),
    lyria: read('MusicGenSettings.jsx'),
    elevenlabs: read('NanoBananaSettings.jsx') + read('ElevenLabsSettings.jsx'),
    sfx: read('NanoBananaSettings.jsx') + read('ElevenLabsSettings.jsx'),
};

describe.each(MEDIA_PANELS.flatMap((panel) => panel.controls.map((c) => [`${c.section}.${c.key}`, c] as const)))('%s', (_name, control) => {
    it('is a key the web writes', () => {
        expect(WEB[control.section]).toMatch(new RegExp(`update\\w*\\('${control.key}'`));
    });

    it("defaults to the web's value", () => {
        const fallback = controlValue(control, undefined);
        if (control.kind === 'options') {
            const literal = typeof fallback === 'number' ? String(fallback) : `'${String(fallback)}'`;
            const byName = /^DEFAULT_TTS_/.test(String(fallback)) ? '' : literal;
            expect(WEB[control.section].includes(byName) || WEB[control.section].includes('DEFAULT_TTS')).toBe(true);
        }
        if (control.kind === 'number') {
            const web = new RegExp(`update\\w*\\('${control.key}', v\\)`);
            const line = WEB[control.section].split('\n').find((l) => web.test(l)) ?? '';
            expect(line).toContain(`defaultVal={${String(fallback)}}`);
        }
    });

    it('carries its words as a key and English', () => {
        expect(control.label.i18nKey).toMatch(/^(chat\.media\.|mobile\.chat\.)/);
    });
});

it('shows a tab only for a generator this person may use', () => {
    const gates = { image: true, music: false, elevenlabs: false, video: false };
    expect(panelsFor(gates).map((p) => p.id)).toEqual(['image']);
    expect(panelsFor({ ...gates, image: false, elevenlabs: true }).map((p) => p.id)).toEqual(['music', 'sfx']);
});
