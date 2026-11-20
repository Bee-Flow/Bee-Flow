/**
 * "Fill in a template" in the composer's "+" menu: the picker's open state, who
 * gets the row, and what choosing a template does.
 *
 * Choosing one SENDS a message: "Fill in the template “<name>” with me.",
 * plus a `[template:<id>]` line (../templatePick.ts) that the model passes to
 * template_fill_start and the user's bubble does not show. The row is direct chat only (the template tools
 * are offered there), and not in an incognito chat: filling in makes a stored
 * document.
 */
import { useState } from 'react';

import type { MyTemplate } from '@/api/queries/projectContent';
import type { TranslateFn } from '@/hooks/useTranslation';
import { templatePickMessage } from '../templatePick';

interface UseTemplateFillInput {
    t: TranslateFn;
    directMode?: boolean;
    simpleMode?: boolean;
    signedIn: boolean;
    incognito: boolean;
    isLoading?: boolean;
    send: (text: string) => void;
}

export default function useTemplateFill({ t, directMode, simpleMode, signedIn, incognito, isLoading, send }: UseTemplateFillInput) {
    const [templatesOpen, setTemplatesOpen] = useState(false);
    const canFillTemplate = !!directMode && !simpleMode && signedIn && !incognito;
    const onPickTemplate = (template: MyTemplate) => {
        setTemplatesOpen(false);
        if (isLoading) return;
        send(templatePickMessage(t('chat_templates.fill_message', 'Fill in the template “{name}” with me.', { name: template.name }), template.id));
    };
    return { canFillTemplate, templatesOpen, setTemplatesOpen, onPickTemplate };
}
