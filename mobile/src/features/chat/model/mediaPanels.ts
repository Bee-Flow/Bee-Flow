/**
 * The media panel's controls as data: which setting each one writes, its
 * words and its choices — the web's NanoBananaSettings, VideoGenSettings and
 * MusicGenSettings, laid out for a phone (tabs of rows instead of popovers).
 * Pinned against those files by mediaPanels.lockstep.test.ts.
 */

import {
    DEFAULT_TTS_MODEL,
    DEFAULT_TTS_VOICE,
    ELEVENLABS_MUSIC_DURATION,
    IMAGE_ASPECT_RATIOS,
    IMAGE_MODELS,
    LYRIA_MODES,
    LYRIA_NUMBERS,
    SFX_NUMBERS,
    TTS_MODELS,
    TTS_VOICES,
    VIDEO_ASPECT_RATIOS,
    VIDEO_DURATIONS,
    VIDEO_MODELS,
    type MediaKind,
    type MediaNumber,
    type MediaOption,
    type MediaSection,
} from './mediaCatalog';

export interface Words {
    i18nKey: string;
    en: string;
}

export type MediaControl =
    | { kind: 'options'; section: MediaSection; key: string; label: Words; options: readonly MediaOption[]; fallback: string | number }
    | { kind: 'number'; section: MediaSection; key: string; label: Words; spec: MediaNumber }
    | { kind: 'switch'; section: MediaSection; key: string; label: Words; hint?: Words };

export interface MediaPanel {
    id: 'image' | 'video' | 'music' | 'sfx';
    tab: Words;
    intro: Words;
    /** The generators this tab configures; it shows when any of them is allowed. */
    kinds: readonly MediaKind[];
    controls: readonly MediaControl[];
}

const w = (i18nKey: string, en: string): Words => ({ i18nKey, en });

const LYRIA_LABELS: Readonly<Record<string, Words>> = {
    bpm: w('mobile.chat.media_bpm', 'BPM'),
    durationSeconds: w('chat.media.duration', 'Duration'),
    density: w('chat.media.lyria_density', 'Density'),
    brightness: w('chat.media.lyria_brightness', 'Brightness'),
    guidance: w('chat.media.lyria_guidance', 'Guidance'),
};

export const MEDIA_PANELS: readonly MediaPanel[] = [
    {
        id: 'image',
        tab: w('chat.media.tab_image', 'Image'),
        intro: w('chat.media.image_intro', 'Ask AI to generate an image. These settings apply automatically.'),
        kinds: ['image'],
        controls: [
            { kind: 'options', section: 'image', key: 'aspectRatio', label: w('chat.media.aspect_ratio', 'Aspect Ratio'), options: IMAGE_ASPECT_RATIOS, fallback: '1:1' },
            { kind: 'options', section: 'image', key: 'model', label: w('chat.media.model', 'Model'), options: IMAGE_MODELS, fallback: 'gemini-3.1-flash-image-preview' },
        ],
    },
    {
        id: 'video',
        tab: w('mobile.chat.media_tab_video', 'Video'),
        intro: w('chat.media.veo_intro', 'Google Veo — AI video generation. Takes 1-3 minutes per clip.'),
        kinds: ['video'],
        controls: [
            { kind: 'options', section: 'video', key: 'model', label: w('chat.media.model', 'Model'), options: VIDEO_MODELS, fallback: 'veo-3.1-generate-preview' },
            { kind: 'options', section: 'video', key: 'aspectRatio', label: w('chat.media.aspect_ratio', 'Aspect Ratio'), options: VIDEO_ASPECT_RATIOS, fallback: '16:9' },
            { kind: 'options', section: 'video', key: 'duration', label: w('chat.media.duration', 'Duration'), options: VIDEO_DURATIONS, fallback: 8 },
        ],
    },
    {
        id: 'music',
        tab: w('chat.media.tab_music_tts', 'Music & TTS'),
        intro: w('chat.media.lyria_intro', 'Instrumental music via Google Lyria. These defaults apply when generating music.'),
        kinds: ['music', 'elevenlabs'],
        controls: [
            ...LYRIA_NUMBERS.map((spec): MediaControl => ({ kind: 'number', section: 'lyria', key: spec.key, label: LYRIA_LABELS[spec.key] as Words, spec })),
            { kind: 'options', section: 'lyria', key: 'mode', label: w('chat.media.lyria_mode', 'Mode'), options: LYRIA_MODES, fallback: 'QUALITY' },
            { kind: 'switch', section: 'lyria', key: 'muteBass', label: w('chat.media.lyria_mute_bass', 'Mute Bass') },
            { kind: 'switch', section: 'lyria', key: 'muteDrums', label: w('chat.media.lyria_mute_drums', 'Mute Drums') },
            { kind: 'number', section: 'elevenlabs', key: 'musicDuration', label: w('chat.media.el_song_duration', 'Song Duration'), spec: ELEVENLABS_MUSIC_DURATION },
            {
                kind: 'switch',
                section: 'elevenlabs',
                key: 'instrumental',
                label: w('chat.media.el_force_instrumental', 'Force Instrumental'),
                hint: w('chat.media.el_instrumental_only', 'No vocals, instrumental only'),
            },
            { kind: 'options', section: 'elevenlabs', key: 'ttsVoice', label: w('chat.media.el_voice', 'Voice'), options: TTS_VOICES, fallback: DEFAULT_TTS_VOICE },
            { kind: 'options', section: 'elevenlabs', key: 'ttsModel', label: w('chat.media.el_tts_model', 'TTS Model'), options: TTS_MODELS, fallback: DEFAULT_TTS_MODEL },
        ],
    },
    {
        id: 'sfx',
        tab: w('chat.media.tab_sfx', 'SFX'),
        intro: w('chat.media.sfx_intro', 'ElevenLabs Sound Effects — ambient sounds, foley, cinematic effects.'),
        kinds: ['elevenlabs'],
        controls: SFX_NUMBERS.map(
            (spec): MediaControl => ({
                kind: 'number',
                section: 'sfx',
                key: spec.key,
                label: spec.key === 'duration' ? w('chat.media.duration', 'Duration') : w('chat.media.el_prompt_influence', 'Prompt Influence'),
                spec,
            }),
        ),
    },
];

/** The switch that turns a generator off for this person's chats (the turn's `disabledMedia`). */
export const MEDIA_KIND_WORDS: Readonly<Record<MediaKind, Words>> = {
    image: w('chat.composer.media_image', 'Image Generation'),
    music: w('chat.composer.media_music', 'Music Generation'),
    video: w('chat.composer.media_video', 'Video Generation'),
    elevenlabs: w('mobile.chat.media_elevenlabs', 'ElevenLabs audio'),
};

/** The tabs this person gets: those with at least one allowed generator. */
export function panelsFor(gates: Readonly<Record<MediaKind, boolean>>): MediaPanel[] {
    return MEDIA_PANELS.filter((panel) => panel.kinds.some((kind) => gates[kind]));
}

/** A control's shown value: what was set, else the web's default. */
export function controlValue(control: MediaControl, set: string | number | boolean | undefined): string | number | boolean {
    if (set !== undefined) return set;
    if (control.kind === 'options') return control.fallback;
    if (control.kind === 'number') return control.spec.fallback;
    return false;
}
