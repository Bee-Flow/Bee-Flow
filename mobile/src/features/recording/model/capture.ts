/**
 * The per-upload settings a new recording starts with.
 */

import { getLocales } from 'expo-localization';

import type { CaptureSettings } from './types';

/** The transcription languages the web client offers, same order, Dutch first. */
export const TRANSCRIPTION_LANGUAGES: readonly { code: string; label: string }[] = [
    { code: 'nl', label: 'Dutch' },
    { code: 'en', label: 'English' },
    { code: 'de', label: 'German' },
    { code: 'fr', label: 'French' },
    { code: 'es', label: 'Spanish' },
    { code: 'it', label: 'Italian' },
    { code: 'pt', label: 'Portuguese' },
    { code: 'pl', label: 'Polish' },
    { code: 'tr', label: 'Turkish' },
    { code: 'ja', label: 'Japanese' },
    { code: 'zh', label: 'Chinese' },
    { code: 'ko', label: 'Korean' },
    { code: 'ar', label: 'Arabic' },
    { code: 'ru', label: 'Russian' },
];

/**
 * The device's language, if we transcribe it; Dutch otherwise.
 *
 * Dutch is the product default on the server (`language = req.body.language ||
 * 'nl'`) and this is a Dutch-first product, so it is the fallback rather than
 * English — but a phone set to German should not have to change the language
 * on every recording.
 */
export function defaultLanguage(): string {
    const code = getLocales()[0]?.languageCode?.toLowerCase();
    return code && TRANSCRIPTION_LANGUAGES.some((l) => l.code === code) ? code : 'nl';
}

/** Blank roster, glossary and speaker count: the form asks for those before the upload. */
export function newCaptureSettings(title: string): CaptureSettings {
    return { title, language: defaultLanguage(), attendees: '', contextTerms: '', numSpeakers: '' };
}
