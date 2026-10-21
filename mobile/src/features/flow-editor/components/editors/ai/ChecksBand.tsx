/**
 * The AI step's "Answer checks" section on the phone: read-only. It says what
 * the step is held to (the checks, the allowed-value lists, the fallback), so
 * an author opening a step built on the web or through MCP sees that these
 * rules exist, and a validation finding about one has a section to open. The
 * rules are edited in the web builder; a save here keeps them untouched
 * (formState/aiStepReliability.ts).
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';

import { Note } from '../shared/Note';
import type { StepEditorProps } from '../types';

const KIND_WORDS: Record<string, [string, string]> = {
    allowedFrom: ['ai_step_checks.kind_allowed', 'Must be one of the values in a list'],
    numbersFrom: ['ai_step_checks.kind_numbers', 'Numbers must come from the data'],
    script: ['ai_step_checks.kind_script', 'Written in one alphabet'],
    items: ['ai_step_checks.kind_items', 'Number of items'],
};

/** The sentence for a kind of rule, or null for a kind this build does not know. */
function kindText(t: (key: string, fallback: string) => string, kind: unknown): string | null {
    const words = KIND_WORDS[String(kind)];
    return words ? t(words[0], words[1]) : null;
}

const asList = (v: unknown): Record<string, unknown>[] =>
    (Array.isArray(v) ? v : []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');

/** How many rules the step carries: checks, allowed-value lists, and a value fallback. */
export function checksCount(draft: Record<string, unknown>): number {
    const fb = draft.fallback as { kind?: string } | null | undefined;
    return asList(draft.checks).length + asList(draft.enumFrom).length + (fb?.kind === 'value' ? 1 : 0);
}

export function ChecksBand({ draft }: Pick<StepEditorProps, 'draft'>) {
    const t = useTranslation();
    const lines: string[] = [];
    for (const e of asList(draft.enumFrom)) {
        lines.push(`${kindText(t, 'allowedFrom')}: ${String(e.field ?? '')}`);
    }
    for (const c of asList(draft.checks)) {
        const kind = kindText(t, c.kind);
        if (kind) lines.push(`${kind}: ${String(c.field ?? '')}`);
    }
    if ((draft.fallback as { kind?: string } | null | undefined)?.kind === 'value') {
        lines.push(t('ai_step_checks.fallback_values', 'Use these values instead'));
    }
    return (
        <>
            <Note>
                {t(
                    'ai_step_checks.section_hint',
                    'Rules the answer must pass. If it does not, the AI is asked once more with a note about what was wrong; if it still fails, the step stops or uses a fallback. Checks look at the finished answer and are never sent to the AI.',
                )}
            </Note>
            {lines.map((line, i) => (
                <Note key={`${i}:${line}`}>{line}</Note>
            ))}
        </>
    );
}
