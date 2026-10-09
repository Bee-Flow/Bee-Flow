import React, { useState } from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import FormField from '../../../../../shared/FormField';
import SegmentedControl from '../../../../../shared/SegmentedControl';
import { KbMultiSelect, ModelTierRow } from '../AiActionEditors';
import { registerInspector } from '../registry';
import { INPUT_CLS, TextAreaField, TextField, usePatch } from './kit';

/**
 * Content panel for the `ai_chat` component. The generic SpecPanel can't render
 * a model-tier picker or a knowledge-base multiselect, so this panel reuses the
 * same controls the AI actions use (AiActionEditors) — one tier/KB UX across
 * every AI surface in App Studio.
 */

const MAX_STARTERS = 6;

export default function AiChatInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const { t } = useTranslation();
    const MODES = [
        { value: 'chat', label: t('studio_apps_panels.ai_chat.mode_chat', 'Conversation') },
        { value: 'assistant', label: t('studio_apps_panels.ai_chat.mode_assistant', 'Single question') },
    ];
    const patch = usePatch(node, definition, onCommit);
    const starters = Array.isArray(props.starters) ? props.starters : [];
    // The textarea keeps its own text: the prop drops blank lines, so joining
    // it back would eat the newline the moment Enter starts a second starter.
    const [startersText, setStartersText] = useState(() => starters.join('\n'));
    const [textFor, setTextFor] = useState(node.id);
    if (textFor !== node.id) {
        setTextFor(node.id);
        setStartersText(starters.join('\n'));
    }

    return (
        <div className="flex flex-col gap-4">
            <TextAreaField
                label={t('studio_apps_panels.ai_chat.system_prompt', 'System prompt')}
                value={props.systemPrompt}
                onChange={(v) => patch({ systemPrompt: v })}
                rows={4}
                placeholder={t('studio_apps_panels.ai_chat.system_prompt_placeholder', 'You are a support assistant for our returns policy…')}
                disabled={disabled}
            />
            <ModelTierRow value={props.modelTier} onChange={(tier) => patch({ modelTier: tier })} disabled={disabled} />
            <KbMultiSelect value={props.knowledgeBaseIds} onChange={(ids) => patch({ knowledgeBaseIds: ids })} disabled={disabled} />
            <FormField label={t('studio_apps_panels.ai_chat.mode', 'Mode')} hint={t('studio_apps_panels.ai_chat.mode_hint', 'A conversation keeps history; a single question answers each one on its own.')}>
                <SegmentedControl
                    value={props.mode ?? 'chat'}
                    onChange={(v) => patch({ mode: v })}
                    options={MODES}
                    size="sm"
                    fullWidth
                    disabled={disabled}
                    ariaLabel={t('studio_apps_panels.ai_chat.chat_mode_aria', 'Chat mode')}
                />
            </FormField>
            <TextField
                label={t('studio_apps_panels.ai_chat.greeting', 'Greeting')}
                value={props.greeting}
                onChange={(v) => patch({ greeting: v })}
                placeholder={t('studio_apps_panels.ai_chat.greeting_placeholder', 'Ask me anything.')}
                disabled={disabled}
            />
            <TextField
                label={t('studio_apps_panels.ai_chat.input_placeholder', 'Input placeholder')}
                value={props.placeholder}
                onChange={(v) => patch({ placeholder: v })}
                placeholder={t('studio_apps_panels.ai_chat.input_placeholder_example', 'Ask a question…')}
                disabled={disabled}
            />
            <FormField label={t('studio_apps_panels.ai_chat.starters', 'Starter questions')} hint={t('studio_apps_panels.ai_chat.starters_hint', 'One per line — shown before the first message.')}>
                <textarea
                    className={`${INPUT_CLS} min-h-[64px]`}
                    value={startersText}
                    onChange={(e) => {
                        setStartersText(e.target.value);
                        patch({
                            starters: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, MAX_STARTERS),
                        });
                    }}
                    rows={3}
                    disabled={disabled}
                    aria-label={t('studio_apps_panels.ai_chat.starters', 'Starter questions')}
                />
            </FormField>
        </div>
    );
}

registerInspector('ai_chat', AiChatInspector);
