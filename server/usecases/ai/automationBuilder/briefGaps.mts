/**
 * Does a request for a NEW automation say enough to plan it? The assistant
 * asks before planning when the brief leaves open where the data comes from
 * (or what starts it), where the result goes, or who is involved. This reads
 * the user's own words (English and Dutch) for those three and names the
 * ones it cannot find. It only decides whether the server nudges the
 * assistant to ask first in Plan first; the assistant still judges the brief
 * itself, so a miss costs one round, never a wrong build.
 */

export type BriefGap = 'source' | 'destination' | 'people';

// Where the data comes from, or what starts the run.
const SOURCE = new RegExp([
    String.raw`\b(?:e-?mails?|mails?|inbox|mailbox|gmail|outlook|forms?|formulier(?:en)?|webhooks?|sheets?|spreadsheets?|excel|tables?|tabel(?:len)?|drive|nextcloud|folders?|map(?:pen)?|files?|bestand(?:en)?|documents?|documenten|calendar|agenda|crm|database|api|rss|feeds?|uploads?|website|webpage|pagina)\b`,
    String.raw`\b(?:when(?:ever)?|every|each|daily|weekly|monthly|hourly|schedule[d]?|wanneer|zodra|elke|iedere|dagelijks|wekelijks|maandelijks|binnenkomt|ontvang\w*|receiv\w*|arriv\w*)\b`,
].join('|'), 'i');

// Where the result goes: something is sent, stored, created or reported.
const DESTINATION = new RegExp(String.raw`\b(?:send|sends|sent|e-?mail (?:it|them|me|to)|mail (?:it|them|me|to)|post|notify|notification|message|reply|forward|save|store|write|add|append|create|update|log|record|report|summar\w+|export|upload|share|stuur\w*|verstuur\w*|stuurt|mail\w* naar|sla\w* op|opslaan|bewaar\w*|schrijf\w*|zet\w* (?:in|op)|voeg\w* toe|maak\w*|meld\w*|melding|bericht\w*|rapport\w*|samenvat\w*|deel|delen|beantwoord\w*|doorstur\w*)\b`, 'i');

// Who is involved: the person themselves, a colleague, a team, a customer.
const PEOPLE = new RegExp(String.raw`(?:\b(?:i|me|my|myself|we|us|our|team|colleagues?|manager|boss|customers?|clients?|users?|employees?|staff|finance|sales|support|hr|someone|everyone|approver|approv\w+|ik|mij|mijn|wij|ons|onze|collega'?s?|klant(?:en)?|medewerkers?|afdeling|iedereen|goedkeur\w*|leidinggevende)\b|@)`, 'i');

// Fewer words than this says nothing a plan can stand on.
const MIN_WORDS = 5;

/** The parts of the brief a plan for a new automation needs and the text does not name. */
export function briefGaps(text: unknown): BriefGap[] {
    const brief = typeof text === 'string' ? text.trim() : '';
    if (brief.split(/\s+/).filter(Boolean).length < MIN_WORDS) return ['source', 'destination', 'people'];
    const gaps: BriefGap[] = [];
    if (!SOURCE.test(brief)) gaps.push('source');
    if (!DESTINATION.test(brief)) gaps.push('destination');
    if (!PEOPLE.test(brief)) gaps.push('people');
    return gaps;
}

/**
 * The user's own words of this request: the message, after their earlier
 * messages in the same conversation (a brief typed over two messages counts
 * as one).
 */
export function briefText(message: unknown, history: unknown): string {
    const earlier = (Array.isArray(history) ? history : [])
        .filter((h): h is { role: string, content: string } => !!h && typeof h === 'object' && (h as { role?: unknown }).role === 'user' && typeof (h as { content?: unknown }).content === 'string')
        .map((h) => h.content);
    return [...earlier, typeof message === 'string' ? message : ''].join('\n').trim();
}
