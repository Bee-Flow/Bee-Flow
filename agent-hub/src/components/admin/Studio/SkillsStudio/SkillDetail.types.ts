import type { Skill, SkillDraft, StepRef } from './skillModel.types';
import type { RefOptions } from './SkillStepEditor.types';
import type { PickerData } from './useSkillPickerData';
import type { UsageRow } from '@/hooks/useUsage';
import type { TranslateFn } from '@/hooks/useTranslation';

/**
 * One skill (Skills artboards 1a and 1b).
 *
 * ── THE SAVE IS THE HARD PART, NOT THE LAYOUT ───────────────────────
 * Everything here autosaves 350ms after the last keystroke, which puts two
 * traps in the way and both are handled explicitly:
 *
 *   1. STRUCTURE, NEVER TEXT. S1's write precedence says a body carrying
 *      `workflow`/`rules`/`examples` makes the TEXT the source and re-parses
 *      the structure from it — which would re-mint every step id under a
 *      drag that is still in flight. `buildSavePayload` sends the structured
 *      facets only; the text columns are regenerated server-side, so a
 *      mobile client still reads exactly what it always read.
 *
 *   2. A 403 IS NOT A RETRY. A skill can be VISIBLE and not editable. S1
 *      answers `403 not_editable` rather than 404 for that case precisely
 *      so this loop can stop instead of re-sending every 350ms; the editor
 *      drops into read-only and says why, once.
 *
 * ── THE HEADER IS THE SHARED ONE ────────────────────────────────────
 * `StudioSectionHeader` with `kind="skill"`: the tile, the rename, the save
 * chip, the segment tabs and the capsule are the same row a knowledge base
 * or a table opens with. The primary action wears the ACCENT recipe
 * (`PRIMARY_ACTION_STYLE`), not the artboard's ink fill — the fill was
 * rejected for interactive elements.
 *
 * ── DELETE LIVES UNDER "USED BY" ────────────────────────────────────
 * Not in the list, not in a ⋯ menu: `DangerZone` sits at the bottom of the
 * tab that shows what deleting would break, and it confirms against the
 * SAME list the tab renders — the rows AND the kinds nobody could check.
 * Both, or the card contradicts the tab it is standing under. The server's 409 `in_use` guard stays the
 * authority — the dialog only ever confirms a list it has shown.
 */
export interface SkillDetailProps {
    skill: Skill & { automationId?: string | null };
    currentUserId?: string | null;
    canManage?: boolean;
    onBack: () => void;
    onSaved: (patch: { id: string; }) => void;
    onDeleted?: (id: string) => void;
    onNavigate?: ((to: string) => void) | null;
}

/** The "Method" body: two cards on top, then steps beside the right rail. */
export interface MethodTabProps {
    draft: SkillDraft;
    patch: (next: Partial<SkillDraft>, immediate?: boolean) => void;
    readOnly: boolean;
    refOptions: RefOptions | null;
    onOpenRef: ((ref: StepRef) => void) | null;
    picker: PickerData;
    legacyAutomationId: string | null;
    usage: UsageRow[] | null;
    unchecked: readonly string[];
    onFillIn: (sentence: string) => void;
    drafting: boolean;
    t: TranslateFn;
}

/**
 * The standing note at the bottom of the right rail (artboard 1a): who uses
 * this, and the one sentence that makes editing here feel safe — "a change
 * applies everywhere at once".
 *
 * It only claims a count it HAS, and there are TWO ways not to have one:
 * the list is still loading, or the read FAILED. `knownUsage` above folds
 * both into null before they get here, so this stays one question — and
 * "No agent or automation uses this skill yet" is never printed off a read
 * that never answered. The Used-by tab is where a failed read gets its own
 * sentence.
 */
export interface UsedByNoteProps {
    usage: UsageRow[] | null;
    unchecked?: readonly string[];
    t: TranslateFn;
}

export interface TextCardProps {
    label: string;
    value: string | number | readonly string[];
    onChange: (value: string) => void;
    readOnly: boolean;
    placeholder: string;
    muted?: boolean;
    hint?: string | null;
    maxLength?: number;
}
