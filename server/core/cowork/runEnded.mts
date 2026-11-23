/**
 * "A run of this item ended": said by the Cowork runner when a run returns (./coworkRunner.js) and by the follow-up
 * when a run that waited for its owner's decision ends (./planRunFollowUp.mts); heard by whoever starts work after it
 * (./afterCowork.mts, started at boot). It imports nothing, so neither side depends on the other.
 */

export interface EndedItem { id: string; userId: string; title?: string | null }
type Listener = (item: EndedItem, runId: string) => void;

const listeners: Listener[] = [];

/** Hear every run that ends; answers how to stop hearing. */
export function onRunEnded(listener: Listener): () => void {
    listeners.push(listener);
    return () => {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
    };
}

/** A run ended. A listener that throws never stops the others, nor the caller. */
export function runEnded(item: EndedItem, runId: string | null | undefined): number {
    if (!runId) return 0;
    let told = 0;
    for (const listener of [...listeners]) {
        try {
            listener(item, runId);
            told += 1;
        } catch {
            // A listener's own failure is its own; it logs what it needs to.
        }
    }
    return told;
}
