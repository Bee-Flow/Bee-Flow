import { Bell, Code, Eye, Filter, Mail, Repeat, Sparkles, WandSparkles } from 'lucide-react';
import useTranslation from '../../../../hooks/useTranslation';

export default function AssistantWelcome({ triggerKind, definition = null, selectedStep = null, onPick }) {
    const { t } = useTranslation();
    const steps = definition?.steps || [];
    const chips = [];
    const suggest = (Icon, key, fallback) => chips.push({ Icon, text: t(`automations.assistant.suggest.${key}`, fallback) });
    if (selectedStep?.type === 'code') suggest(Code, 'code', 'Write the code for the selected step');
    if (selectedStep?.type === 'ai_step') suggest(Sparkles, 'prompt', 'Improve the instruction for this AI step');
    if (selectedStep && steps.length) suggest(WandSparkles, 'mapping', 'Check the field mappings of this step');
    if (steps.length) {
        suggest(Repeat, 'loop', 'Process each item with AI');
        suggest(Filter, 'filter', 'Only let through the items that match my conditions');
        suggest(Bell, 'notify', 'Send me a message when the flow finishes');
    } else if (triggerKind === 'schedule') suggest(Mail, 'digest', 'Summarise the latest activity and email me a digest');
    else if (triggerKind === 'app_event') suggest(Filter, 'event', 'Filter these items, then draft a reply for each');
    else if (triggerKind === 'webhook') suggest(WandSparkles, 'webhook', 'Validate the incoming data and send me a notification');
    else {
        suggest(Mail, 'invoices', 'Read invoices from my inbox and save them in a table');
        suggest(Sparkles, 'summary', 'Summarise a document with AI');
        suggest(Bell, 'approval', 'Ask someone to approve a request');
    }
    return <div className="flex flex-col gap-5 py-5 text-left">
        <div><h2 className="text-sm font-semibold text-[var(--text-primary)]">{t('automations.assistant.welcome', 'What should this automation do?')}</h2>
            <p className="text-xs leading-5 mt-1 text-[var(--text-secondary)]">{t('automations.assistant.welcome_hint', 'Describe it in ordinary language. Choose how much the assistant may do below.')}</p></div>
        {(steps.length > 0 || selectedStep) && <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]"><Eye size={13} /><span>{t('automations.assistant.watching', 'Looking at:')}</span><span>{steps.length} {t('automations.assistant.steps_short', 'steps')}</span>{selectedStep && <span className="text-[var(--text-secondary)]">· {selectedStep.label || selectedStep.type}</span>}</div>}
        <div><div className="text-[11px] font-medium text-[var(--text-tertiary)] mb-2">{t('automations.assistant.matches', 'Fits this flow')}</div><div className="flex flex-col gap-2">
            {chips.slice(0, 4).map(({ Icon, text }) => <button key={text} type="button" onClick={() => onPick?.(text)} className="flex items-center gap-2.5 text-left text-xs p-2.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--type-ai)] transition"><Icon size={14} className="shrink-0 text-[var(--text-tertiary)]" /><span>{text}</span></button>)}
        </div></div>
    </div>;
}
