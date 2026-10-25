// Scoped-localStorage settings store for the media-generation popovers.
// Replaces the recurring
//   const STORAGE_KEY = 'nanoBananaSettings';
//   function getSettings() { return scopedStorage.getJSON(STORAGE_KEY, {}); }
//   function saveSettings(section, data) { ... }
// helper pair that was copy-pasted into ElevenLabsSettings, VideoGenSettings,
// MusicGenSettings and NanoBananaSettings. All four panels persist into the
// same 'nanoBananaSettings' blob, one section per panel ('image',
// 'elevenlabs', 'sfx', 'video', 'lyria') — use the shared
// `mediaGenSettingsStore` instance below so migration/mirroring stays
// consistent, or `createSettingsStore(key)` for a store on another key.

import scopedStorage from './scopedStorage';

/** One panel's persisted settings. */
export type SettingsSection = Record<string, unknown>;

/** Every panel's settings, keyed by section ('image', 'elevenlabs', 'sfx', 'video', 'lyria'). */
type SettingsBlob = Record<string, SettingsSection>;

/** Hooks of {@link createSettingsStore}. */
export interface SettingsStoreOptions {
    /** Called when the key is empty; may return settings recovered from a legacy key. */
    migrate?: () => SettingsBlob | null;
    /** Called after every persist, e.g. to mirror a section into a legacy key. */
    onSave?: (settings: SettingsBlob) => void;
}

/**
 * Build a sectioned settings store on top of a scopedStorage JSON key.
 *
 * `storageKey` is the scopedStorage key holding the settings object.
 */
function createSettingsStore(storageKey: string, { migrate, onSave }: SettingsStoreOptions = {}) {
    const getAll = (): SettingsBlob => {
        const stored = scopedStorage.getJSON<SettingsBlob>(storageKey, null);
        if (stored) return stored;
        return (migrate && migrate()) || {};
    };

    const saveAll = (settings: SettingsBlob): SettingsBlob => {
        scopedStorage.setJSON(storageKey, settings);
        if (onSave) onSave(settings);
        return settings;
    };

    const getSection = (section: string): SettingsSection => getAll()[section] || {};

    const saveSection = (section: string, data: SettingsSection): SettingsBlob => saveAll({ ...getAll(), [section]: data });

    return { getAll, saveAll, getSection, saveSection };
}

// Shared store for the chat composer media popovers. The legacy
// 'imageGenSettings' key is migrated on first read and mirrored on save
// because the useChatEngine payload path still reads it directly.
export const mediaGenSettingsStore = createSettingsStore('nanoBananaSettings', {
    migrate: () => {
        const old = scopedStorage.getJSON<SettingsSection>('imageGenSettings', null);
        return old ? { image: old } : null;
    },
    onSave: (settings) => {
        if (settings.image) scopedStorage.setJSON('imageGenSettings', settings.image);
    },
});

