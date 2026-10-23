import type { KbUsageSummary, KbSuggestion, KnowledgeBase } from './knowledgeApi';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type React from 'react';
import type { RelativeTimeInput } from '../../../../hooks/useRelativeTime';
import type { FreshnessKb } from './freshness';

/**
 * Studio → Knowledge: every knowledge base, with how current it is and what
 * uses it (Knowledge artboard 1c-right, 884×640).
 *
 * ── THE LIST ANSWERS "IS THIS WORKING", NOT "HOW BIG IS IT" ─────────
 * The old sidebar showed a name and a document count. A document count is
 * the one number that cannot tell you whether a knowledge base is doing its
 * job: 140 documents nobody reads and 0 documents three agents depend on
 * look equally fine. So each row carries the two facts that DO answer it —
 * who uses this (the pills, K5) and when content last arrived (the
 * freshness cell) — and the count moves into the meta line where it belongs.
 *
 * ── "ZONDER CATEGORIE" IS A BUCKET, NOT A GAP ───────────────────────
 * The old chip row was built from `usedCategoryIds`, so a KB with no
 * category was reachable only through "Alle" — invisible the moment someone
 * filtered. Uncategorised is where a KB lands by default, which makes it the
 * bucket most likely to hold the one nobody has looked after. It gets its
 * own chip, and only when at least one KB is actually in it.
 *
 * ── A FAILING /categories MUST NOT TAKE THE LIST DOWN ────────────────
 * Kept from KBsStudio, deliberately: categories are chrome, the list is the
 * page. The catch is on the categories call alone so a 500 there costs the
 * chips and nothing else.
 */
export interface KnowledgeOverviewProps {
    hasPermission?: (permission: string) => boolean;
    usageByKb?: Record<string, KbUsageSummary> | null;
    onOpen: (id: string) => void;
    onCreate: (() => Promise<void>) | undefined;
    suggestion?: (KbSuggestion & { text: string }) | null;
    onAcceptSuggestion?: ((suggestion: KbSuggestion & { text: string }) => Promise<void>) | null;
    onDismissSuggestion?: ((suggestion: KbSuggestion & { text: string }) => void) | null;
    createError?: string | null;
}

/** `Alle · <cat> · Zonder categorie` — the artboard's chip row. */
export interface CategoryChipsProps {
    t: TranslateFn;
    value: string;
    onChange: React.Dispatch<React.SetStateAction<string>>;
    categories: { id: string; name: string }[];
    hasUncategorised: boolean;
}

export interface SearchBoxProps {
    t: TranslateFn;
    value: string;
    onChange: React.Dispatch<React.SetStateAction<string>>;
}

/**
 * One row: `grid 1fr 200px 160px`, radius 12, bg-card, border, shadow-sm,
 * padding 14 — the artboard's measurements literally.
 */
export interface KbRowProps {
    t: TranslateFn;
    rel: (dateLike: RelativeTimeInput) => string;
    kb: KnowledgeBase;
    categoryName: string | null;
    usage: KbUsageSummary | null;
    onOpen: () => void;
}

/**
 * "3 agents · 1 skill", or the dashed warning pill when nothing uses it.
 *
 * `usage === null` means K5's summary has not loaded (or has not shipped):
 * the cell stays EMPTY rather than claiming "door niemand gebruikt", which
 * would be a wrong accusation dressed as a fact.
 */
export interface UsagePillsProps {
    t: TranslateFn;
    usage: KbUsageSummary | null;
}

/** The right-hand cell: a dot and a sentence, or the red "leeg, wel in gebruik". */
export interface FreshnessCellProps {
    t: TranslateFn;
    rel: (dateLike: RelativeTimeInput) => string;
    kb: FreshnessKb;
    usage: KbUsageSummary | null;
}

export interface NoKnowledgeYetProps {
    t: TranslateFn;
    canCreate: boolean;
    onCreate: (() => void) | undefined;
}

/**
 * "This knowledge base fits that agent" (K5).
 *
 * A suggestion on a front page has to be dismissible, or it is an
 * instruction. "Not now" is remembered per person in scopedStorage — never
 * shared, because one colleague deciding a pairing is wrong is not the
 * organisation deciding it.
 */
export interface SuggestionBannerProps {
    t: TranslateFn;
    suggestion: KbSuggestion & { text: string };
    onAccept?: ((suggestion: KbSuggestion & { text: string }) => unknown) | null;
    onDismiss?: ((suggestion: KbSuggestion & { text: string }) => unknown) | null;
}
