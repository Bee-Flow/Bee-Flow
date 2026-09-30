/**
 * The media generators the composer can set defaults for, and their options —
 * the web's ImageGenSettings, VideoGenSettings, MusicGenSettings and
 * ElevenLabsSettings panels as data (pinned by mediaCatalog.lockstep.test.ts).
 * Model and voice names are the vendors' and are not translated, as on the web.
 */

/** A generator as the org and the person can switch it (disabledMedia's keys). */
export type MediaKind = 'image' | 'music' | 'elevenlabs' | 'video';

/** The section of the settings blob each panel writes (mediaGenSettingsStore). */
export type MediaSection = 'image' | 'video' | 'lyria' | 'elevenlabs' | 'sfx';

/**
 * One choice. `name` is how the vendor spells it — a model or a voice is a
 * product name and reads the same in every language, as on the web — and
 * `i18nKey`, when present, is a word this app does translate.
 */
export interface MediaOption {
    name: string;
    value: string | number;
    i18nKey?: string;
}

/** A number the panel sets on a slider: its range, step and the default it shows. */
export interface MediaNumber {
    key: string;
    min: number;
    max: number;
    step: number;
    fallback: number;
    unit?: string;
}

/** Which org integration each generator hangs off, and which key it needs (InputArea's showImageGen & co). */
export const MEDIA_GATES: Readonly<Record<MediaKind, { integration: string; key: 'google' | 'elevenlabs' }>> = {
    image: { integration: 'image-gen', key: 'google' },
    music: { integration: 'music-gen', key: 'google' },
    elevenlabs: { integration: 'elevenlabs', key: 'elevenlabs' },
    video: { integration: 'video-gen', key: 'google' },
};

export const MEDIA_KINDS: readonly MediaKind[] = ['image', 'music', 'elevenlabs', 'video'];

export const IMAGE_ASPECT_RATIOS: readonly MediaOption[] = ['1:1', '16:9', '9:16', '4:3', '3:4'].map((v) => ({ name: v, value: v }));
export const IMAGE_MODELS: readonly MediaOption[] = [
    { name: 'Flash Image (Fast)', value: 'gemini-3.1-flash-image-preview' },
    { name: 'Pro Image (Quality)', value: 'gemini-3-pro-image-preview' },
];

export const VIDEO_MODELS: readonly MediaOption[] = [
    { name: 'Veo 3.1 (Quality)', value: 'veo-3.1-generate-preview' },
    { name: 'Veo 3.0 Fast (Speed)', value: 'veo-3.0-fast-generate-001' },
];
export const VIDEO_ASPECT_RATIOS: readonly MediaOption[] = ['16:9', '9:16'].map((v) => ({ name: v, value: v }));
export const VIDEO_DURATIONS: readonly MediaOption[] = [4, 6, 8].map((v) => ({ name: `${v}s`, value: v }));

export const LYRIA_NUMBERS: readonly MediaNumber[] = [
    { key: 'bpm', min: 60, max: 200, step: 1, fallback: 90 },
    { key: 'durationSeconds', min: 5, max: 30, step: 1, fallback: 10, unit: 's' },
    { key: 'density', min: 0, max: 1, step: 0.05, fallback: 0.5 },
    { key: 'brightness', min: 0, max: 1, step: 0.05, fallback: 0.5 },
    { key: 'guidance', min: 0, max: 6, step: 0.1, fallback: 4 },
];
export const LYRIA_MODES: readonly MediaOption[] = [
    { name: 'Quality', value: 'QUALITY', i18nKey: 'chat.media.lyria_mode_quality' },
    { name: 'Diversity', value: 'DIVERSITY', i18nKey: 'chat.media.lyria_mode_diversity' },
];

export const ELEVENLABS_MUSIC_DURATION: MediaNumber = { key: 'musicDuration', min: 3, max: 120, step: 1, fallback: 30, unit: 's' };
export const SFX_NUMBERS: readonly MediaNumber[] = [
    { key: 'duration', min: 0.5, max: 30, step: 0.5, fallback: 5, unit: 's' },
    { key: 'promptInfluence', min: 0, max: 1, step: 0.05, fallback: 0.5 },
];

export const TTS_MODELS: readonly MediaOption[] = [
    { name: 'Flash v2.5 (Fast)', value: 'eleven_flash_v2_5' },
    { name: 'v3 (Highest Quality)', value: 'eleven_v3' },
    { name: 'Multilingual v2', value: 'eleven_multilingual_v2' },
];
export const DEFAULT_TTS_MODEL = 'eleven_flash_v2_5';

export const TTS_VOICES: readonly MediaOption[] = [
    { name: 'George (Default)', value: 'JBFqnCBsd6RMkjVDRZzb' },
    { name: 'Rachel', value: '21m00Tcm4TlvDq8ikWAM' },
    { name: 'Drew', value: '29vD33N1CtxCmqQRPOHJ' },
    { name: 'Clyde', value: '2EiwWnXFnvU5JabPnv8n' },
    { name: 'Paul', value: '5Q0t7uMcjvnagumLfvZi' },
    { name: 'Domi', value: 'AZnzlk1XvdvUeBnXmlld' },
    { name: 'Bella', value: 'EXAVITQu4vr4xnSDxMaL' },
    { name: 'Antoni', value: 'ErXwobaYiN019PkySvjV' },
    { name: 'Elli', value: 'MF3mGyEYCl7XYWbV9V6O' },
    { name: 'Josh', value: 'TxGEqnHWrfWFTfGW9XjX' },
    { name: 'Arnold', value: 'VR6AewLTigWG4xSOukaG' },
    { name: 'Adam', value: 'pNInz6obpgDQGcFmaJgB' },
    { name: 'Sam', value: 'yoZ06aMxZJJ28mfd3POQ' },
];
export const DEFAULT_TTS_VOICE = 'JBFqnCBsd6RMkjVDRZzb';
