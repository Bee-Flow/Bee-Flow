/**
 * The brief "Make it a cowork" (./CoworkHabitChip.tsx) hands to the Cowork page. It goes through this tab's
 * sessionStorage and is taken out once read, never through the address: a chat message in a URL would stay in the
 * browser history and in the access log of every proxy on the way, and "it notices what you repeat" keeps no text.
 * A `brief` in the address (a link made by hand, or an old bookmark) is read once and then removed from it.
 *
 * In a private window, touching sessionStorage throws; then the brief does not travel and Cowork opens with an empty box.
 */
const KEY = 'beeflow.cowork.handedBrief';
const MAX = 4000;

const storage = (): Storage | null => {
    try { return window.sessionStorage; } catch { return null; }
};

/** Hand a brief to the Cowork page this tab opens next. Answers whether it could be handed over. */
export function handBrief(brief: string): boolean {
    try {
        storage()?.setItem(KEY, brief.slice(0, MAX));
        return true;
    } catch {
        return false;
    }
}

/** The handed-over brief, taken out of storage; '' when there is none or storage cannot be read. */
function takeStored(): string {
    try {
        const store = storage();
        const handed = store?.getItem(KEY) ?? '';
        store?.removeItem(KEY);
        return handed;
    } catch {
        return '';
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

/** The brief handed over, if any; read once, when Cowork opens. */
export function takeHandedBrief(): string {
    const fromAddress = takeFromAddress();
    return (takeStored() || fromAddress).slice(0, MAX);
}
