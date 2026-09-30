/**
 * One spec field on screen: shown or not (visibleWhen), its value read and
 * written through the spec (runtime.ts), its words translated, a costly
 * change asked about first, and the kind's renderer (renderers.tsx).
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { readableExample } from '@/features/flow-editor/components/outline/readableText';
import type { FormDraft } from '@/features/flow-editor/formState';
import { useConfirm } from '@/shared/patterns';

import { RENDERERS } from './renderers';
import { isVisible, readField, resolveWords, say, writeField } from './runtime';
import type { FieldSpec, SpecContext } from './spec';

export function FieldRenderer({
    field,
    draft,
    ctx,
    onDraft,
}: {
    field: FieldSpec;
    draft: FormDraft;
    ctx: SpecContext;
    onDraft: (next: FormDraft) => void;
}) {
    const t = useTranslation();
    const confirm = useConfirm();
    if (!isVisible(field, draft, ctx)) return null;

    const set = async (value: unknown) => {
        const cost = field.confirm?.(value, draft, ctx);
        if (cost) {
            const go = await confirm({
                title: t('common.are_you_sure', 'Are you sure?'),
                message: say(t, cost.message),
                confirmLabel: say(t, cost.action),
                tone: 'primary',
            });
            if (!go) return;
        }
        onDraft(writeField(field, value, draft, ctx));
    };
    const Render = RENDERERS[field.kind];
    return (
        <Render
            field={field}
            value={readField(field, draft, ctx)}
            set={(v) => void set(v)}
            draft={draft}
            ctx={ctx}
            t={t}
            label={say(t, resolveWords(field.label, draft, ctx)) || undefined}
            hint={say(t, resolveWords(field.hint, draft, ctx)) || null}
            // A `{{…}}` in an example reads as its pill would: "Offerte ‹Trigger ▸ Bedrijf›".
            prompt={field.prompt ? say(t, field.prompt) : readableExample(field.example, field.kind === 'path')}
            required={field.required}
            disabled={ctx.disabled}
        />
    );
}
