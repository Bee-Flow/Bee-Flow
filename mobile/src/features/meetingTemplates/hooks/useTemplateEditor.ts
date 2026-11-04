/**
 * The template editor's state: the draft, save and delete. The sheet renders
 * it; the screen decides which template (or none, for a new one) is open.
 */

import { useEffect } from 'react';

import { useTranslation } from '@/core/i18n';
import { useConfirm, useForm } from '@/shared/patterns';

import { useDeleteTemplate, useSaveTemplate } from './queries';
import { draftFrom, draftReady, emptyDraft, seedDraft } from '../model/draft';
import type { SummaryTemplate, TemplateDraft, TemplateScope } from '../model/types';

export function useTemplateEditor(
    template: SummaryTemplate | null,
    visible: boolean,
    onDone: () => void,
    defaultScope: TemplateScope = 'user',
) {
    const t = useTranslation();
    const confirm = useConfirm();
    const save = useSaveTemplate();
    const remove = useDeleteTemplate();
    const form = useForm<TemplateDraft>({
        initial: emptyDraft(),
        onSubmit: (draft) => save.mutateAsync({ id: template?.id ?? null, draft }),
    });
    const { reset } = form;
    const { reset: resetDelete } = remove;

    // Re-seed whenever the sheet opens on another template (or a new one).
    // The sheet stays mounted between opens, so a failed delete's error is
    // cleared here too; a save error lives in the form and `reset` clears it.
    useEffect(() => {
        if (!visible) return;
        reset(template ? draftFrom(template) : emptyDraft(defaultScope));
        resetDelete();
        // `reset` is a fresh closure each render; the trigger is the target.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, template]);

    const submit = async () => {
        if (await form.submit()) onDone();
    };

    const destroy = async () => {
        if (!template) return;
        const ok = await confirm({
            title: t('meetings.template_delete_title', 'Delete this template?'),
            message: t('meeting_notes.template_delete_confirm', 'Delete this template? This cannot be undone.'),
            confirmLabel: t('common.delete', 'Delete'),
        });
        if (!ok) return;
        remove.mutate(template.id, { onSuccess: onDone });
    };

    const seed = (builtin: SummaryTemplate) => {
        const next = seedDraft(form.values, builtin);
        form.set('prompt', next.prompt);
        form.set('name', next.name);
    };

    return {
        form,
        ready: draftReady(form.values),
        submit,
        destroy,
        seed,
        deleting: remove.isPending,
        error: form.submitError ?? remove.error,
    };
}
