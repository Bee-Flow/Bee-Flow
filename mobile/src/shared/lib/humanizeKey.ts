/**
 * A machine key made readable: `contact_email` → "Contact email",
 * `github_url` → "GitHub url"; and a tool name: `gmail_send` → "Gmail Send".
 *
 * Port of `PROPER_CASE`, `humanizeFieldKey` and `humanizeToolName` from the
 * web builder's flow/displayHelpers.js, which the web's datatable screens
 * borrow too for a column that arrived without a name (a mirror, an import, a
 * form's answers), and the run screens for a step or a field. Pinned to the
 * web by flow-editor's summaries.lockstep.test.ts and datatables'
 * display.lockstep.test.ts.
 */

/** Proper-noun casing the web curates, so 'github' reads GitHub, not Github. */
const PROPER_CASE: Readonly<Record<string, string>> = {
    gmail: 'Gmail', github: 'GitHub', youtrack: 'YouTrack', afas: 'AFAS', nmbrs: 'NMBRS',
    nextcloud: 'Nextcloud', google: 'Google', docs: 'Docs', sheets: 'Sheets', slides: 'Slides',
    drive: 'Drive', calendar: 'Calendar', contacts: 'Contacts', keep: 'Keep', groups: 'Groups',
    maps: 'Maps', outlook: 'Outlook', onedrive: 'OneDrive', ms: 'Microsoft', fireflies: 'Fireflies',
    elevenlabs: 'ElevenLabs', linkedin: 'LinkedIn', signrequest: 'SignRequest', n8n: 'n8n',
    kb: 'Knowledge Base', deck: 'Deck', talk: 'Talk', tasks: 'Tasks', notes: 'Notes', mail: 'Mail',
    activity: 'Activity', notifications: 'Notifications', status: 'Status', tts: 'TTS', sfx: 'SFX',
    ai: 'AI', pdf: 'PDF',
};

/** The curated casing of a lower-case word, if it has one (own keys only: 'constructor' is a word, not a method). */
export const properCase = (word: string): string | undefined =>
    Object.prototype.hasOwnProperty.call(PROPER_CASE, word) ? PROPER_CASE[word] : undefined;

/** Sentence case — "From email", never "From Email" — with the curated nouns kept. */
export function humanizeFieldKey(key: unknown): string {
    const raw = String(key || '').trim();
    if (!raw) return '';
    const words = raw
        .replace(/[_\-.]+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/\s+/)
        .filter(Boolean);
    if (!words.length) return raw;
    return words
        .map((w, i) => properCase(w.toLowerCase()) || (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()))
        .join(' ');
}

function titleWord(token: string): string {
    if (!token) return '';
    const lower = token.toLowerCase();
    return properCase(lower) || lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** `gmail_send` → "Gmail Send"; `elevenlabs_tts` → "ElevenLabs TTS". */
export function humanizeToolName(toolName: unknown): string {
    if (!toolName || typeof toolName !== 'string') return '';
    return toolName.split('_').filter(Boolean).map(titleWord).join(' ');
}
