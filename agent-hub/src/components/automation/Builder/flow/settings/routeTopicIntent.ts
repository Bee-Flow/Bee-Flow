/**
 * "Suggest outputs" for routing by MEANING: "split complaints from invoices
 * and questions" or "verdeel in klachten, facturen en vragen" becomes one
 * `isAbout(<text field>, "<topic>")` output per topic, answered at run time by
 * the topic classifier (server/shared/expr/topics.mjs).
 *
 * Pure, like routeIntents.js, and tried LAST there: file types, dates, numbers
 * and quoted words are exact rules and always win over a classifier's
 * judgement. It is only offered when the builder catalog says a classifier is
 * installed; otherwise the sentence falls through to the model fallback and
 * the AI-step handoff exactly as before.
 *
 * What it will not do: read a single word with no routing marker as a topic.
 * "blah" is not a request to route on meaning, and a suggestion for it would
 * be noise in the one box that promises to understand what it shows.
 */

export interface TopicField {
    path: string;
    label?: string;
    sample?: unknown;
}

const MAX_TOPIC_CHARS = 60;
const MAX_TOPIC_WORDS = 6;

// Verbs and fillers that open a routing sentence, English and Dutch. Removed
// from the START only: "sort out complaints" → "complaints".
const LEAD = /^(?:please\s+|graag\s+)?(?:split|sort|route|separate|divide|group|classify|filter|keep|send|splits|sorteer|verdeel|scheid|groepeer|filter|houd|stuur)\b(?:\s+(?:out|up|op|uit))?\s*/;
const FILLER = /^(?:only|just|alleen|enkel)\s+|^(?:these|those|the|all|my|our|incoming|new|deze|die|de|het|alle|mijn|onze|nieuwe|binnenkomende)\s+/;
const NOUNS = /^(?:e-?mails?|mails?|messages?|files?|documents?|tickets?|items?|records?|rows?|requests?|berichten|bestanden|documenten|aanvragen|verzoeken|regels)\b\s*/;
const PREP = /^(?:into|in|by|to|from|between|about|on|over|naar|op|tussen|van)\s+/;
// Splits the remainder into topics.
const SEPARATORS = /\s*(?:,|;|\/|\bvs\.?\b|\bversus\b|\band\b|\bor\b|\bfrom\b|\ben\b|\bof\b|\bvan\b)\s*/;
// The "otherwise" output already catches these; a topic called "other" would
// score nothing useful.
const CATCH_ALL = /^(?:other|others|the rest|rest|everything else|something else|anything else|anders|overig|overige|de rest|iets anders|al het andere)$/;
// A single topic counts only after one of these: "keep only complaints",
// "about a refund", "gaat over een klacht".
const ROUTING_MARKER = /\b(?:split|sort|route|separate|divide|group|classify|keep|only|about|splits|sorteer|verdeel|scheid|groepeer|houd|alleen|gaat over|over)\b/;

function stripLead(text: string): string {
    let s = text;
    for (let i = 0; i < 6; i++) {
        const next = s.replace(LEAD, '').replace(FILLER, '').replace(NOUNS, '').replace(PREP, '');
        if (next === s) break;
        s = next;
    }
    return s;
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The topics a sentence names, in order, without the verbs, fillers and
 * catch-alls around them. Empty when the sentence is not a routing request.
 *
 * `fieldNames` are the names of a field the author mentioned ("split the
 * subject into …"): that mention says where to read, not what to look for.
 */
export function readTopics(sentence: string, fieldNames: string[] = []): string[] {
    let lower = String(sentence || '').trim().toLowerCase().replace(/[.!?]+$/, '');
    for (const name of fieldNames) {
        const n = String(name || '').trim().toLowerCase();
        if (n.length < 3) continue;
        lower = lower.replace(new RegExp(`(?:\\b(?:the|de|het)\\s+)?\\b${escapeRe(n)}\\b(?:\\s+(?:into|in|by|op|naar))?\\s*`, 'g'), ' ').trim();
    }
    if (!lower) return [];
    const body = stripLead(lower);
    const seen = new Set<string>();
    const topics: string[] = [];
    for (const raw of body.split(SEPARATORS)) {
        const t = stripLead(raw.trim()).replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
        if (!t || CATCH_ALL.test(t) || seen.has(t)) continue;
        if (t.length > MAX_TOPIC_CHARS || t.split(/\s+/).length > MAX_TOPIC_WORDS) continue;
        seen.add(t);
        topics.push(t);
    }
    if (topics.length === 1 && !ROUTING_MARKER.test(lower)) return [];
    return topics;
}

// Fields that hold the text worth reading, best first. A subject is a fair
// second; a name or an id says nothing about what an item is about.
const BODY_KEYS = /^(body|text|message|content|description|snippet|summary|notes?|comment|question|answer|bericht|tekst|inhoud|omschrijving)$/;
const HEAD_KEYS = /^(subject|title|onderwerp|titel)$/;

function keyOf(field: TopicField): string {
    const cleaned = String(field?.path || '').replace(/\[(?:\*|\d+)\]/g, '');
    return (cleaned.split('.').filter(Boolean).pop() || '').toLowerCase();
}

/**
 * The field whose text says most about what an item is: a body over a
 * subject, a long sample over a short one. Null when nothing looks like text,
 * so the caller says so instead of guessing (routeIntents.js's own rule).
 */
export function pickTopicField(fields: TopicField[]): TopicField | null {
    let best: TopicField | null = null;
    let bestScore = 0;
    for (const f of fields || []) {
        if (!f?.path) continue;
        const key = keyOf(f);
        let s = 0;
        if (BODY_KEYS.test(key)) s += 3;
        else if (HEAD_KEYS.test(key)) s += 2;
        if (typeof f.sample === 'string') s += f.sample.length > 80 ? 2 : 1;
        if (s > bestScore) { best = f; bestScore = s; }
    }
    return bestScore >= 2 ? best : null;
}
