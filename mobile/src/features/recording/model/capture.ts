/**
 * The per-upload settings a new recording starts with.
 */

import { getLocales } from 'expo-localization';

import { translate } from '@/core/i18n';

import type { CaptureSettings } from './types';

/**
 * The transcription languages the web client offers, same order, Dutch first.
 * `label` is a getter, so the name is read in the app's language each time a
 * screen draws it (the screen's own `useTranslation` re-renders it when the
 * catalogue lands) while the list keeps the plain `{ code, label }` shape its
 * other readers map over.
 */
export const TRANSCRIPTION_LANGUAGES: readonly { code: string; label: string }[] = [
    { code: 'nl', get label() { return translate('mobile.recording.lang_nl', 'Dutch'); } },
    { code: 'en', get label() { return translate('mobile.recording.lang_en', 'English'); } },
    { code: 'de', get label() { return translate('mobile.recording.lang_de', 'German'); } },
    { code: 'fr', get label() { return translate('mobile.recording.lang_fr', 'French'); } },
    { code: 'es', get label() { return translate('mobile.recording.lang_es', 'Spanish'); } },
    { code: 'it', get label() { return translate('mobile.recording.lang_it', 'Italian'); } },
    { code: 'pt', get label() { return translate('mobile.recording.lang_pt', 'Portuguese'); } },
    { code: 'pl', get label() { return translate('mobile.recording.lang_pl', 'Polish'); } },
    { code: 'tr', get label() { return translate('mobile.recording.lang_tr', 'Turkish'); } },
    { code: 'ja', get label() { return translate('mobile.recording.lang_ja', 'Japanese'); } },
    { code: 'zh', get label() { return translate('mobile.recording.lang_zh', 'Chinese'); } },
    { code: 'ko', get label() { return translate('mobile.recording.lang_ko', 'Korean'); } },
    { code: 'ar', get label() { return translate('mobile.recording.lang_ar', 'Arabic'); } },
    { code: 'ru', get label() { return translate('mobile.recording.lang_ru', 'Russian'); } },
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
