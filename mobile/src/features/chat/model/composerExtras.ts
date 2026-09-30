/** What only some chat surfaces offer in the composer. */

import type { MediaKind } from './mediaCatalog';
import type { ShieldWords } from './shieldLine';

/** Memoise it where it is built: a new object re-renders the composer. */
export interface ComposerExtras {
    /** The Privacy Shield's claim beside send. */
    shield?: ShieldWords | null;
    /** Which media generators this person may use; any true adds "Create media". */
    mediaGates?: Readonly<Record<MediaKind, boolean>>;
    /** Offer the apps this chat may reach. */
    apps?: boolean;
    /** Offer dictation beside send. */
    dictation?: boolean;
    /** This send goes into a thread. */
    thread?: { title: string | null; onExit: () => void } | null;
    /** A sentence about the context that did not work out (a knowledge base that could not be saved). */
    notice?: string | null;
}
