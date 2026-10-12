import { RefreshCw, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { readingLocale, useTranslation } from '../../../../hooks/useTranslation';
import { useSuggestDescriptionMutation } from '../../../../api/queries/automation/settings';
import { LINK_BTN, PRIMARY_BTN, SECONDARY_BTN } from './settingsUi';

interface Props {
    automationId: string;
    onAccept: (text: string) => void;
    /** Take the proposal into the field and let the user rework it. */
    onEdit: (text: string) => void;
}

/**
 * "Let Bee suggest a description based on the steps" (artboard 5e-1): a link
 * that turns into a proposal card with Accept · Edit · Another suggestion.
 */
// The keys this card renders: Bee writes in the language they are shown in.
const LANGUAGE_ANCHORS = ['automations.settings.suggest_link', 'automations.settings.suggest_title', 'automations.settings.suggest_accept'];

export default function DescriptionSuggestion({ automationId, onAccept, onEdit }: Props) {
    const { t, locale, strings } = useTranslation();
    // The language of Bee Flow as it is ON SCREEN (the user's choice, or the
    // one Nextcloud handed over), measured against the keys this card shows.
    // A preference of 'nl' on a deployment whose Dutch catalogue does not
    // cover these screens reads English, so the proposal is English too:
    // an English page was getting a Dutch description (owner, 2026-09-29).
    const suggest = useSuggestDescriptionMutation(readingLocale(locale, strings, LANGUAGE_ANCHORS));
    const [proposal, setProposal] = useState<string | null>(null);

    const ask = () => suggest.mutate(automationId, { onSuccess: (text) => setProposal(text || null) });

    if (!proposal) {
        return (
            <div className="flex flex-col gap-1">
                <button type="button" onClick={ask} disabled={suggest.isPending} className={`${LINK_BTN} self-start text-[var(--type-ai)]`}>
                    <Sparkles size={12} />
                    {suggest.isPending
                        ? t('automations.settings.suggest_busy', 'Bee is reading the steps…')
                        : t('automations.settings.suggest_link', 'Let Bee suggest a description based on the steps')}
                </button>
                {suggest.isError && (
                    <span role="alert" className="text-[12px] text-[var(--error)]">{suggest.error.message}</span>
                )}
            </div>
        );
    }

    const close = () => { setProposal(null); suggest.reset(); };
    return (
        <div className="rounded-[10px] border border-[color-mix(in_srgb,var(--type-ai)_40%,transparent)] bg-[color-mix(in_srgb,var(--type-ai)_6%,var(--bg-card))] p-3 flex flex-col gap-2 text-[12px]">
            <div className="flex items-center gap-1.5 font-semibold text-[var(--type-ai)]">
                <Sparkles size={12} /> {t('automations.settings.suggest_title', 'Suggestion from Bee')}
            </div>
            <p className="leading-[17px] text-[var(--text-primary)]">{proposal}</p>
            <div className="flex items-center gap-2 flex-wrap">
                <button type="button" className={PRIMARY_BTN} onClick={() => { onAccept(proposal); close(); }}>
                    {t('automations.settings.suggest_accept', 'Accept')}
                </button>
                <button type="button" className={SECONDARY_BTN} onClick={() => { onEdit(proposal); close(); }}>
                    {t('automations.settings.suggest_edit', 'Edit')}
                </button>
                <button type="button" className={SECONDARY_BTN} onClick={ask} disabled={suggest.isPending}>
                    <RefreshCw size={12} className={suggest.isPending ? 'animate-spin' : ''} />
                    {t('automations.settings.suggest_another', 'Another suggestion')}
                </button>
            </div>
            {suggest.isError && <span role="alert" className="text-[var(--error)]">{suggest.error.message}</span>}
        </div>
    );
}
