import { useState, useEffect } from 'react';
import { mediaGenSettingsStore } from '../utils/mediaGenSettingsStore';

/** One panel's slice of the media-gen settings blob: free-form keys, values
 *  as whatever that panel persists (a voice id, a seed, an aspect ratio). */
export type MediaGenSection = Record<string, unknown>;

export type MediaGenSectionUpdate = (key: string, val: unknown) => void;

/**
 * Read one media-gen settings section from `mediaGenSettingsStore`, re-reading
 * when `isOpen` flips true (so an edit made elsewhere shows on reopen), and
 * persist edits.
 *
 * Replaces the getSection + read-on-open useEffect + update triad that each
 * media settings panel re-implemented.
 */
export default function useMediaGenSection(
    section: string,
    isOpen: boolean,
): [MediaGenSection, MediaGenSectionUpdate] {
    const [settings, setSettings] = useState<MediaGenSection>(
        () => mediaGenSettingsStore.getSection(section),
    );

    useEffect(() => {
        if (isOpen) setSettings(mediaGenSettingsStore.getSection(section));
    }, [isOpen, section]);

    const update: MediaGenSectionUpdate = (key, val) => {
        const next = { ...settings, [key]: val };
        setSettings(next);
        mediaGenSettingsStore.saveSection(section, next);
    };

    return [settings, update];
}
