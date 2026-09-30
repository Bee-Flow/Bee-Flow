/**
 * Display naming for integration apps and their actions in the step picker —
 * a port of the web builder's flow/appLabels.js, pinned by
 * palette.lockstep.test.ts.
 *
 * The catalog's action labels are mechanical (`name.replace(/_/g, ' ')`) and
 * its descriptions are written for the MODEL. So names drop what the
 * surrounding app already says, and descriptions keep only the part about
 * the action. Nothing here touches a payload: a node keeps the full name.
 */

const vendorWord = (category: unknown) => String(category || '').trim().split(/\s+/)[0] || '';

/** The vendor's own core app has no word left once the vendor word goes. */
const BASE_APP_LABEL: Readonly<Record<string, string>> = { nextcloud: 'Files' };

/** What an app is called INSIDE its category ("Nextcloud Talk" → "Talk"). */
export function shortAppLabel(label: unknown, category: unknown, integrationId: string | null = null): string {
    const full = String(label || '').trim();
    const vendor = vendorWord(category);
    if (!full || !vendor) return full;
    if (full.toLowerCase() === vendor.toLowerCase()) {
        return (integrationId && Object.prototype.hasOwnProperty.call(BASE_APP_LABEL, integrationId) ? BASE_APP_LABEL[integrationId] : '') || full;
    }
    if (full.toLowerCase().startsWith(`${vendor.toLowerCase()} `)) return full.slice(vendor.length + 1).trim() || full;
    return full;
}

interface ActionRef {
    tool?: string;
    label?: string;
}

const isMechanicalLabel = (a: ActionRef) => !a?.label || String(a.label).trim() === String(a.tool || '').replace(/_/g, ' ');

/** The longest leading run of `_` tokens every name shares, leaving at least one. */
function commonTokenPrefix(names: string[]): number {
    if (names.length < 2) return 0;
    const split = names.map((n) => String(n).split('_'));
    const first = split[0] as string[];
    const cap = Math.min(...split.map((s) => s.length)) - 1;
    let i = 0;
    while (i < cap && split.every((s) => s[i] === first[i])) i += 1;
    return i;
}

const sentenceCase = (text: string) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);

/** tool → the label to SHOW, given its app's whole action list. A human label is kept as-is. */
export function actionLabelMap(actions: readonly ActionRef[] | null | undefined = []): Map<string, string> {
    const list = (actions || []).filter((a): a is ActionRef & { tool: string } => !!a && !!a.tool);
    const skip = commonTokenPrefix(list.filter(isMechanicalLabel).map((a) => a.tool));
    const out = new Map<string, string>();
    for (const a of list) {
        if (!isMechanicalLabel(a)) {
            out.set(a.tool, a.label as string);
            continue;
        }
        const rest = String(a.tool).split('_').slice(skip).join(' ');
        out.set(a.tool, sentenceCase(rest) || String(a.label || a.tool));
    }
    return out;
}

/** Sentences written AT the model: instructions for calling the tool. */
const MODEL_DIRECTED = [
    /\bthe user has (already )?approved\b/i,
    /^go ahead\b/i,
    /^(always )?call (this|the)\b/i,
    /^use this (tool )?(first|when|only)\b/i,
];

const MAX_SENTENCES = 2;
const MAX_CHARS = 180;

/** An action's description, as an author should read it. */
export function uiDescription(desc: unknown): string {
    const flat = String(desc || '').replace(/\s+/g, ' ').trim();
    if (!flat) return '';
    const kept = flat
        .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
        .filter((s) => !MODEL_DIRECTED.some((re) => re.test(s.trim())))
        .slice(0, MAX_SENTENCES)
        .join(' ')
        .trim()
        .replace(/\s*[—-]\s*$/, '');
    if (!kept) return '';
    if (kept.length <= MAX_CHARS) return kept;
    const cut = kept.slice(0, MAX_CHARS);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > 60 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:]$/, '')}…`;
}
