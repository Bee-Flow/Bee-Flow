/**
 * The media generators' defaults, per person and on this phone — the web keeps
 * them in scopedStorage under `nanoBananaSettings` (one section per panel),
 * mirrors the image section as `imageGenSettings`, and keeps the generators a
 * person dimmed as `disabledMedia` (MediaCreationPanel, mediaGenSettingsStore).
 * All three ride on every direct-chat turn, as they do from the browser.
 *
 * A zustand store persisted to AsyncStorage: the composer's sheet writes it,
 * the send path reads it, and nothing needs a provider above both.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useStore } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';

import type { MediaKind, MediaSection } from './mediaCatalog';

export type MediaValue = string | number | boolean;
export type MediaSectionValues = Readonly<Record<string, MediaValue>>;

export interface MediaSettingsState {
    sections: Readonly<Partial<Record<MediaSection, MediaSectionValues>>>;
    disabled: Readonly<Partial<Record<MediaKind, boolean>>>;
    set: (section: MediaSection, key: string, value: MediaValue) => void;
    toggle: (kind: MediaKind) => void;
}

/** What the turn body carries (streamTurn.js destructures all three). */
export interface MediaPayload {
    imageGenSettings: Record<string, unknown>;
    nanoBananaSettings: Record<string, unknown>;
    disabledMedia: Record<string, boolean>;
}

export const mediaSettingsStore = createStore<MediaSettingsState>()(
    persist(
        (set) => ({
            sections: {},
            disabled: {},
            set: (section, key, value) =>
                set((s) => ({ sections: { ...s.sections, [section]: { ...s.sections[section], [key]: value } } })),
            toggle: (kind) => set((s) => ({ disabled: { ...s.disabled, [kind]: !s.disabled[kind] } })),
        }),
        {
            name: 'beeflow.chat.media.v1',
            storage: createJSONStorage(() => AsyncStorage),
            partialize: (s) => ({ sections: s.sections, disabled: s.disabled }),
        },
    ),
);

export function useMediaSettings<T>(select: (s: MediaSettingsState) => T): T {
    return useStore(mediaSettingsStore, select);
}

/** The three keys as the web sends them. */
export function mediaPayload(state: Pick<MediaSettingsState, 'sections' | 'disabled'>): MediaPayload {
    return {
        imageGenSettings: { ...state.sections.image },
        nanoBananaSettings: { ...state.sections },
        disabledMedia: Object.fromEntries(Object.entries(state.disabled).filter(([, v]) => v === true)) as Record<string, boolean>,
    };
}

/** The current payload, read at send time. */
export function currentMediaPayload(): MediaPayload {
    return mediaPayload(mediaSettingsStore.getState());
}
