/**
 * The screens a visit has been on, for the `back` step
 * (server/appStudio/componentSpecs/steps/back.js). The runner observes the
 * screen it is told about on every render; a change of screen, or of its params
 * (a detail screen for another record), puts the screen it left on the trail.
 * `back()` takes the last one off and marks the next change as the return, so
 * going back never adds the screen it came from: back, back walks two screens
 * back instead of swinging between two.
 */

interface ScreenEntry {
    id: string;
    params: Record<string, unknown>;
}

export interface ScreenTrail {
    /** The screen the run surface shows now ({ id, params }); anything else is ignored. */
    observe: (screen: unknown) => void;
    /** The screen to return to (and it leaves the trail), or null at the start of the visit. */
    back: () => ScreenEntry | null;
}

/** How many screens the trail remembers; older ones fall off. */
const MAX_TRAIL = 50;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function entryOf(screen: unknown): ScreenEntry | null {
    if (!isObject(screen) || typeof screen.id !== 'string' || !screen.id) return null;
    return { id: screen.id, params: isObject(screen.params) ? screen.params : {} };
}

function signature(entry: ScreenEntry): string {
    try { return `${entry.id}\u0000${JSON.stringify(entry.params)}`; } catch { return entry.id; }
}

export function createScreenTrail(max = MAX_TRAIL): ScreenTrail {
    const trail: ScreenEntry[] = [];
    let current: ScreenEntry | null = null;
    let currentSig = '';
    let returning = false;
    return {
        observe(screen) {
            const next = entryOf(screen);
            if (!next) return;
            const sig = signature(next);
            if (current && sig === currentSig) return;
            if (current && !returning) {
                trail.push(current);
                if (trail.length > max) trail.shift();
            }
            returning = false;
            current = next;
            currentSig = sig;
        },
        back() {
            const prev = trail.pop() ?? null;
            if (prev) returning = true;
            return prev;
        },
    };
}
