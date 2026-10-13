/**
 * The leaf of the mapping library: primitives that the field pickers, the
 * pills, the condition rows and the list-shape notes all name things with,
 * and that import nothing else from Builder/.
 *
 * They used to live in flow/displayHelpers.js and mapping/fieldKinds.js, which
 * pulled each other in through refTokens, conditionModel and listShape: twelve
 * files that could only load as one cycle. Both modules still re-export what
 * moved here, so their importers did not change.
 */
import { pathLabelParts } from '../../../../utils/bindingHelpers';

/**
 * The ONE ISO-date regex. utils/conditionModel.js used to carry its own;
 * it imports this now so a value cannot be a date in one picker and text in
 * another.
 */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}|$)/;

// Hand-curated proper-noun casing so 'gmail' renders as 'Gmail' instead
// of 'Gmail' is fine but 'github' should render as 'GitHub', 'youtrack'
// as 'YouTrack', etc. Anything not listed falls through to title-case.
export const PROPER_CASE: Readonly<Record<string, string>> = {
    gmail: 'Gmail',
    github: 'GitHub',
    youtrack: 'YouTrack',
    afas: 'AFAS',
    nmbrs: 'NMBRS',
    nextcloud: 'Nextcloud',
    google: 'Google',
    docs: 'Docs',
    sheets: 'Sheets',
    slides: 'Slides',
    drive: 'Drive',
    calendar: 'Calendar',
    contacts: 'Contacts',
    keep: 'Keep',
    groups: 'Groups',
    maps: 'Maps',
    outlook: 'Outlook',
    onedrive: 'OneDrive',
    ms: 'Microsoft',
    fireflies: 'Fireflies',
    elevenlabs: 'ElevenLabs',
    linkedin: 'LinkedIn',
    signrequest: 'SignRequest',
    n8n: 'n8n',
    kb: 'Knowledge Base',
    deck: 'Deck',
    talk: 'Talk',
    tasks: 'Tasks',
    notes: 'Notes',
    mail: 'Mail',
    activity: 'Activity',
    notifications: 'Notifications',
    status: 'Status',
    tts: 'TTS',
    sfx: 'SFX',
    ai: 'AI',
    pdf: 'PDF', ocr: 'OCR',
};

/**
 * A data field's key rendered as a plain English name — `subject` → "Subject",
 * `from_email` → "From email", `messageId` → "Message id", `htmlUrl` → "HTML url".
 *
 * Used wherever a non-technical user picks a field: they should read the name of
 * the thing ("Subject"), never its path (`item.subject`). Reuses the same
 * proper-noun table as the tool-name humanizer, so `pdf` stays "PDF".
 */
export function humanizeFieldKey(key: unknown): string {
    const raw = String(key || '').trim();
    if (!raw) return '';
    const words = raw
        .replace(/[_\-.]+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')   // camelCase → camel Case
        .split(/\s+/)
        .filter(Boolean);
    if (!words.length) return raw;
    return words
        .map((w, i) => {
            const known = PROPER_CASE[w.toLowerCase()];
            if (known) return known;
            // Only the first word is capitalised — "From email", not "From Email";
            // sentence case reads as a label, title case reads as a heading.
            return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase();
        })
        .join(' ');
}

/** "1st", "2nd", "last" — an index the way a person counts. */
function ordinalLabel(index: number): string {
    if (index === -1) return 'last';
    const n = Math.abs(index < 0 ? index : index + 1);
    const v = n % 100;
    const suffix = (v >= 11 && v <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] || 'th';
    return index < 0 ? `${n}${suffix} from last` : `${n}${suffix}`;
}

/** Text that is no path: its last dotted segment, brackets dropped. */
function lastSegmentLabel(text: string): string {
    const seg = String(text).replace(/\[[^\]]*\]/g, '').split('.').filter(Boolean).pop();
    return seg ? humanizeFieldKey(seg) : '';
}

type LabelParts = { leaf?: string | null; parent?: string | null; index?: number | null } | null | undefined;

/**
 * The readable name of a field path, the way its pill names it (the pills
 * call this too, through refTokens.fieldTailLabel): the field's own key,
 * humanised — `fields["Story Points"]` reads "Story points",
 * `headers[name="Subject"].value` "Subject". A generic key gets the key that
 * says whose it is (`from.emailAddress.address` → "From ▸ Address", so a
 * sender's and a recipient's address read differently), and an index right
 * after the key says which one (`items[0]` → "Items ▸ 1st"). Wildcards and
 * indexes further up are dropped; the exact path stays on the pill's tooltip
 * (BFSF-330).
 */
export function humanizeFieldTail(fieldPath: unknown): string {
    const tail = String(fieldPath ?? '').trim();
    if (!tail) return '';
    const parts = pathLabelParts(tail) as LabelParts;
    if (!parts || !parts.leaf) return parts?.index != null ? ordinalLabel(parts.index) : lastSegmentLabel(tail);
    const name = humanizeFieldKey(parts.leaf) || parts.leaf;
    const head = parts.parent ? `${humanizeFieldKey(parts.parent) || parts.parent} ▸ ${name}` : name;
    return parts.index == null ? head : `${head} ▸ ${ordinalLabel(parts.index)}`;
}
