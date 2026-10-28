import type { Example, Rule } from './skillModel.types';
import type React from 'react';
import type { TranslateFn } from '@/hooks/useTranslation';

/**
 * "Examples" — what a good answer looks like (Skills artboard 1b).
 *
 * Each card is question → good answer (+ why it is good) and, optionally,
 * "Not like this" with the rule it breaks. The bad half is opt-in on
 * purpose: a wrong answer in the prompt is a thing the model has now READ,
 * so it earns its place only when the agent keeps getting one specific
 * thing wrong. The card only asks for it once the good half exists.
 *
 * ── "PICK FROM A CONVERSATION" ──────────────────────────────────────
 * The real source of a good example is an answer that already happened.
 * Two rules make that safe, and both live on the server (routes/skills/
 * examples.js), not here:
 *   - the conversation must be the CALLER'S OWN. `getConversationById` has
 *     no owner filter, so an id from someone else's chat would otherwise
 *     read out their conversation — an IDOR. The route checks `user_id`.
 *   - the text is read with `{restore: false}` (Privacy Shield tokens stay
 *     tokens) and scanned again before it is stored, which is what the
 *     artboard's "personal data is removed automatically" promises.
 * `sourceConversationId` is kept as PROVENANCE only. It is never rendered
 * as a link: the example may be read by colleagues who cannot open that
 * chat, and a link that 404s for half its readers is worse than none.
 */
export interface ExamplesTabProps {
    skillId: string;
    examples: Example[];
    rules?: Rule[];
    readOnly?: boolean;
    onChange: (examples: Example[]) => void;
}

/**
 * One example card.
 *
 * ── A RULE THAT WAS DELETED ─────────────────────────────────────────
 * The rule an example points at can be removed in the Rules tab, and rule
 * ids are stable (skillStructure mints one per rule and keeps it), so the
 * reference simply stops resolving. A `<select>` with no option carrying its
 * own value shows the FIRST one instead — so the card read "No specific
 * rule" while `violatedRuleId` still held the dead id, and kept saving that
 * id on every write. `orphanRule` gives the dead reference an option of its
 * own: the screen and the data then say the same thing, and picking anything
 * else replaces it. Clearing it here instead would be an edit nobody asked
 * for, fired by a render — the mistake `bad: ' '` already made once below.
 */
export interface ExampleCardProps {
    example: Example;
    rules: Rule[];
    readOnly: boolean;
    onPatch: (next: Partial<Example>) => void;
    onRemove: React.MouseEventHandler<HTMLButtonElement>;
    t: TranslateFn;
}

export interface FieldProps {
    label: string;
    labelColor: string;
    borderColor?: string;
    value: string | number | readonly string[];
    readOnly: boolean;
    onChange: (value: string) => void;
    surface?: boolean;
}

/**
 * The conversation → message picker. Both reads go through the skills
 * router, which is where the "your own conversation only" check lives; this
 * component never touches the agents API, so there is exactly one owner
 * check to get right instead of two.
 */
export interface FromConversationPickerProps {
    skillId: string;
    onClose: () => void;
    onAdded: (example: Example) => void;
    t: TranslateFn;
}

export interface PickerConversation {
    id: string;
    title?: string;
    agentName?: string;
}

export interface PickerMessage {
    index: number;
    role: string;
    text: string;
}

export interface BusyProps {
    t: TranslateFn;
}
