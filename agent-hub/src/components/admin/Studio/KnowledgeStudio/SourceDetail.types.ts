import type { KbSource, KbDocument } from './knowledgeApi';
import type { ScheduleChange } from './ScheduleMenu';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { RelativeTimeInput } from '@/hooks/useRelativeTime';
import type React from 'react';

/**
 * One source, opened: every document in it, what came out of each, and
 * whether it held personal data (Knowledge artboard 1b, 1600×760).
 *
 * ── THE STATUS COLUMN IS THE POINT ──────────────────────────────────
 * Before the source model a failed file left NO ROW AT ALL: it was
 * extracted, the extraction returned nothing, and the document was deleted
 * on the way out. From the outside a folder of 38 files quietly became a
 * knowledge base of 36, with nothing anywhere saying which two were missing
 * or why. `status` + `status_reason` (K1a) are what make that visible, and
 * this table is where a person reads them.
 *
 * ── "AFGESCHERMD" IS A PROMISE, SO IT GETS A SENTENCE ───────────────
 * The `redacted` status means personal data was replaced BEFORE the text
 * entered the knowledge base — the agent knows the terms, not the customer.
 * That is a privacy claim, and a claim made only by a small shield icon is
 * a claim most people will never read. The banner under the table spells it
 * out, which is the artboard's own choice.
 *
 * ── ONE DOCUMENT'S BODY, ON DEMAND, NEVER THE LIST ──────────────────
 * The list route is projected and carries no `original_content` (K1b), so
 * opening a 38-file folder does not ship 38 bodies to the browser.
 */
export interface SourceDetailProps {
    kbId: string;
    kbName: string | null;
    source: KbSource;
    onRenamed?: ((sid: string, name: string) => void) | null;
    onSchedule?: ((sid: string, refresh: ScheduleChange) => unknown) | null;
    canManage?: boolean;
    onBack: () => void;
    onChanged: () => void;
}

export interface LoadArgs {
    quiet?: boolean;
}

/** `Alle n · Verwerkt n · Overgeslagen n · Met persoonsgegevens n`. */
export interface FilterChipsProps {
    t: TranslateFn;
    value: string;
    onChange: (value: string) => void;
    source?: Partial<KbSource>;
}

export interface DocRowProps {
    t: TranslateFn;
    rel: (dateLike: RelativeTimeInput) => string;
    doc: KbDocument;
    last: boolean;
    canManage: boolean;
    kbId: string;
    onChanged: () => void;
}

export interface PagerProps {
    t: TranslateFn;
    total: number;
    offset: number;
    onOffset: React.Dispatch<React.SetStateAction<number>>;
}
