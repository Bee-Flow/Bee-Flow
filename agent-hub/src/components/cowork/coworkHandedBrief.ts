/**
 * The brief "Make it a cowork" (./CoworkHabitChip.tsx) hands to the Cowork page. It goes through this tab's
 * sessionStorage and is taken out once read, never through the address: a chat message in a URL would stay in the
 * browser history and in the access log of every proxy on the way, and "it notices what you repeat" keeps no text.
 * A `brief` in the address (a link made by hand, or an old bookmark) is read once and then removed from it.
 *
 * The weekday the brief was asked on travels with it ("You ask this every Monday"), so Cowork opens set to run it
 * every week on that day (./useCoworkComposer.ts).
 *
 * In a private window, touching sessionStorage throws; then the brief does not travel and Cowork opens with an empty box.
 */
const KEY = 'beeflow.cowork.handedBrief';
const MAX = 4000;

const storage = (): Storage | null => {
    try { return window.sessionStorage; } catch { return null; }
};

/** What travels: the brief, and the weekday (0 Sunday … 6 Saturday) it is asked on, or null. */
export interface HandedBrief { brief: string; weekday: number | null }

const NOTHING: HandedBrief = { brief: '', weekday: null };

const isWeekday = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 6;

/** Hand a brief to the Cowork page this tab opens next. Answers whether it could be handed over. */
export function handBrief(brief: string, weekday: number | null = null): boolean {
    try {
        storage()?.setItem(KEY, JSON.stringify({ brief: brief.slice(0, MAX), weekday: isWeekday(weekday) ? weekday : null }));
        return true;
    } catch {
        return false;
    }
}

/** What was stored, read as a handed brief; anything else is nothing. */
function parseStored(raw: string): HandedBrief {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return NOTHING;
        const { brief, weekday } = parsed as Record<string, unknown>;
        return { brief: typeof brief === 'string' ? brief : '', weekday: isWeekday(weekday) ? weekday : null };
    } catch {
        return NOTHING;
    }
}

/** The handed-over brief, taken out of storage; nothing when there is none or storage cannot be read. */
function takeStored(): HandedBrief {
    try {
        const store = storage();
        const raw = store?.getItem(KEY) ?? '';
        store?.removeItem(KEY);
        return raw ? parseStored(raw) : NOTHING;
    } catch {
        return NOTHING;
    }
}

/** A `brief` in the address, removed from it; '' when there is none. */
function takeFromAddress(): string {
    try {
        const url = new URL(window.location.href);
        const inAddress = url.searchParams.get('brief');
        if (inAddress === null) return '';
        url.searchParams.delete('brief');
        window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
        return inAddress;
    } catch {
        return '';
    }
}

/** The brief handed over, if any, with its weekday; read once, when Cowork opens. An address brief has no weekday. */
export function takeHandedBrief(): HandedBrief {
    const fromAddress = takeFromAddress();
    const stored = takeStored();
    if (stored.brief) return { brief: stored.brief.slice(0, MAX), weekday: stored.weekday };
    return { brief: fromAddress.slice(0, MAX), weekday: null };
}
