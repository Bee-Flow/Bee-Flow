import { SKILL_EMOJI_ICONS } from '../../constants/icons';
import type { TextTab } from './SkillFormModal.types';

/**
 * The LIGHT skill maker — the one that opens from a chat surface and from
 * the agent's Skills tab, next to the full editor in Studio.
 *
 * It stays deliberately light: a name, a description and the four text
 * fields. Studio owns the structured shape (steps as cards, rules with a
 * polarity, examples as question/answer pairs, the fields a skill delivers);
 * this modal exists so somebody who is in the middle of a conversation can
 * write a skill down without leaving it.
 *
 * ── TEXT IS THE SOURCE HERE, AND THAT IS A REAL CONSEQUENCE ─────────
 * S1's write precedence (server/core/skills/skillStructure.resolveBodyWrite)
 * says: a body that carries `workflow`/`rules`/`examples` and NO structure
 * stores the text and re-parses the structure FROM it. So editing the
 * workflow text of a skill that has steps in Studio replaces those steps —
 * ids, references and all.
 *
 * That is the right precedence (the person is looking at the text they are
 * editing), but it must not be a surprise, so a skill that HAS structure
 * says so above the field. Hiding the field instead would leave a skill
 * nobody can fix from here; saying nothing is how a step's references
 * disappear without anyone noticing.
 *
 * ── AND THE COMPARISON IS THIS FILE'S JOB, NOT THE SERVER'S ─────────
 * `resolveBodyWrite` compares nothing with what is stored: any `workflow`
 * that ARRIVES is re-parsed, and `parseWorkflowToSteps` mints a fresh id
 * per line with `refs: []`. So "unchanged text leaves the structure alone"
 * is only true if the unchanged text is never sent — which is what
 * `payloadOf` below does. Renaming a skill from this modal used to
 * re-mint every step id and drop every reference pill of a skill somebody
 * had built in Studio, and nothing on screen said so.
 *
 * ── A SKILL A SOLUTION STAGE MANAGES IS READ-ONLY, EXCEPT WHO SEES IT ──
 * `skill.managed` (the GET carries it) turns every text field, the icon and
 * the name into plain reading, puts the banner under the header and sends
 * the sharing fields ALONE: sharing is on the stage's allow-list, the text is
 * only ever changed by a deploy. A save the stage refuses anyway (409
 * managed_part, e.g. a tab opened before the stage took the skill over) turns
 * the same switch on.
 *
 * Everything this modal does not send is left alone by the server
 * (`undefined` = "leave as-is"), so a skill's steps, output fields, grants
 * and dynamic activation survive a save from here untouched.
 */
// Re-export for callers that already import ICONS from this module.
export const ICONS = SKILL_EMOJI_ICONS;

export const INSTRUCTION_LIMIT = 4000;

/**
 * The four text tabs. Labels, hints and placeholders go through t() at
 * render time — the list itself is static data, so the keys stay literal
 * (i18nGuard's rule) and a translator sees them all in one place.
 */
export const TABS: { id: TextTab; labelKey: string; labelEn: string; hintKey: string; hintEn: string; phKey: string; phEn: string; structureField?: string }[] = [
    {
        id: 'instructions',
        labelKey: 'skill_form.tab.instructions', labelEn: 'Instructions',
        hintKey: 'skill_form.hint.instructions', hintEn: 'What should the AI do? Be specific and detailed.',
        phKey: 'skill_form.ph.instructions',
        phEn: 'e.g. When asked to summarize a meeting, extract all key decisions, action items with owners, and open questions...',
    },
    {
        id: 'workflow',
        labelKey: 'skill_form.tab.workflow', labelEn: 'Workflow',
        hintKey: 'skill_form.hint.workflow', hintEn: 'Step-by-step process to follow.',
        phKey: 'skill_form.ph.workflow',
        phEn: 'e.g.\n1. Read the transcript\n2. Extract action items\n3. List decisions made\n4. Output in structured format...',
        structureField: 'steps',
    },
    {
        id: 'rules',
        labelKey: 'skill_form.tab.rules', labelEn: 'Rules',
        hintKey: 'skill_form.hint.rules', hintEn: "Tone, format rules, dos and don'ts.",
        phKey: 'skill_form.ph.rules',
        phEn: 'e.g.\n- Always use bullet points\n- Keep summaries under 300 words\n- Highlight action items in bold...',
        structureField: 'rulesV2',
    },
    {
        id: 'examples',
        labelKey: 'skill_form.tab.examples', labelEn: 'Examples',
        hintKey: 'skill_form.hint.examples', hintEn: 'Example outputs or input/output pairs.',
        phKey: 'skill_form.ph.examples',
        phEn: 'e.g. Input: "Meeting transcript..."\nOutput: "## Summary\n..."',
        structureField: 'examplesV2',
    },
];

/**
 * The one warning about rewriting text over a structure Studio owns.
 *
 * One step is an ordinary skill, so the count really can be 1 — and the
 * house convention (I18N-CONVENTIES §2) puts the ternary around the KEY,
 * never around a letter in the sentence: base key = singular,
 * `<key>_plural` = many, so a translator sees the pair side by side.
 */
export const STRUCTURE_WARNING: Record<string, { one: { key: string; en: string; }; many: { key: string; en: string; }; }> = {
    steps: {
        one: { key: 'skill_form.replaces_steps', en: 'This skill has {count} step in Studio. Rewriting the text here replaces it, references and all.' },
        many: { key: 'skill_form.replaces_steps_plural', en: 'This skill has {count} steps in Studio. Rewriting the text here replaces them, references and all.' },
    },
    rulesV2: {
        one: { key: 'skill_form.replaces_rules', en: 'This skill has {count} rule in Studio. Rewriting the text here replaces it.' },
        many: { key: 'skill_form.replaces_rules_plural', en: 'This skill has {count} rules in Studio. Rewriting the text here replaces them.' },
    },
    examplesV2: {
        one: { key: 'skill_form.replaces_examples', en: 'This skill has {count} example in Studio. Rewriting the text here replaces it.' },
        many: { key: 'skill_form.replaces_examples_plural', en: 'This skill has {count} examples in Studio. Rewriting the text here replaces them.' },
    },
};

/**
 * The three text fields that OVERWRITE a structure Studio owns. Any other
 * field this modal edits (name, description, instructions, icon, sharing)
 * has no structured counterpart, so sending it unchanged costs nothing.
 */
export const STRUCTURED_TEXT_FIELDS: readonly ('workflow' | 'rules' | 'examples')[] = Object.freeze(['workflow', 'rules', 'examples']);
