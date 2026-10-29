import { X } from 'lucide-react';
import type { ChangeEvent } from 'react';
import type { TranslateFn, TranslateParams } from '@/hooks/useTranslation';
import Disclosure from '@/components/shared/Disclosure';
import type { PillProps } from './CanUseCard.types';
import type { SkillDraft } from './skillModel.types';

/**
 * The presentational pieces of CanUseCard (the grant pills, the link menu's
 * status line, the unread-lists note and the "All options" disclosure).
 */

/**
 * Which reads did not come back, by name. Never a bare "something went
 * wrong": a person who sees this line twice needs to be able to tell whether
 * it is the same list both times. It stands outside the menu because it also
 * explains a pill that shows an id instead of a name.
 */
export function GrantGapNote({ t, gapNames, reloadLists }: { t: TranslateFn; gapNames: string[]; reloadLists: (() => void) | null | undefined }) {
    return (
        <p
            className="text-[11.5px] m-0 text-[var(--warning)] flex flex-wrap items-baseline gap-x-2"
            data-testid="skill-grant-gap"
            // It is a statement about the state of the screen, and it
            // appears without anybody typing — so it is announced. The
            // agent builder's own version of this note (`UnreadableNotice`)
            // has said so since A2.
            role="status"
        >
            <span>
                {t(
                    'skills_studio.canuse.unread',
                    'Could not be read: {lists}. That is not “you have none” — what is missing is left out here rather than shown as empty.',
                    { lists: gapNames.join(', ') },
                )}
            </span>
            {reloadLists && (
                <button
                    type="button"
                    onClick={reloadLists}
                    data-testid="skill-grant-retry"
                    className="underline decoration-dotted text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition"
                >
                    {t('skills_studio.canuse.retry', 'Try again')}
                </button>
            )}
        </p>
    );
}

export function CanUseCardDisclosure({ t, dynamicActivation, readOnly, onChange, legacyAutomationId }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; dynamicActivation: boolean | undefined; readOnly: boolean; onChange: (patch: Partial<SkillDraft>) => void; legacyAutomationId: string | null; }) {
    return <Disclosure
        title={t('skills_studio.options.title', 'All options')}
        className="mt-1"
    >
        <div className="flex flex-col gap-3 pt-1">
            <label className="flex items-start gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
                <input
                    type="checkbox"
                    checked={!!dynamicActivation}
                    disabled={readOnly}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ dynamicActivation: e.target.checked })}
                    data-testid="skill-dynamic"
                    className="mt-0.5" />
                <span>
                    <span className="block font-medium text-[var(--text-primary)]">
                        {t('skills_studio.field.dynamic_label', 'Dynamic activation')}
                    </span>
                    {t('skills_studio.field.dynamic_help', 'When on, the agent decides at runtime whether to apply this skill based on the user message.')}
                </span>
            </label>

            {legacyAutomationId && (
                <p className="text-xs m-0 text-[var(--text-secondary)]" data-testid="skill-legacy-automation">
                    {t(
                        'skills_studio.options.legacy_automation',
                        'This skill runs automation {id} instead of its own steps. Steps, rules and examples are ignored while that is set.',
                        { id: legacyAutomationId }
                    )}
                </p>
            )}
        </div>
    </Disclosure>;
}

/**
 * The one line in the link menu, and EXACTLY one of three. The first two are
 * the pair this menu exists to keep apart: "still asking" and "we could not
 * ask" are neither of them "you have nothing to link".
 */
export function MenuStatus({ t, loaded, gap, empty }: { t: TranslateFn; loaded: boolean; gap: boolean; empty: boolean }) {
    if (!loaded) {
        return (
            <p className="px-3 py-2 m-0 text-xs text-[var(--text-tertiary)]" data-testid="skill-grant-loading">
                {t('skills_studio.canuse.loading', 'Loading…')}
            </p>
        );
    }
    if (gap) {
        return (
            <p className="px-3 py-2 m-0 text-xs text-[var(--warning)]" data-testid="skill-grant-menu-gap">
                {t('skills_studio.canuse.unread_menu', 'Some of these lists could not be read, so this is not “nothing to link”.')}
            </p>
        );
    }
    if (!empty) return null;
    return (
        <p className="px-3 py-2 m-0 text-xs text-[var(--text-tertiary)]" data-testid="skill-grant-none">
            {t('skills_studio.canuse.nothing', 'Nothing else to link. An automation appears here once its trigger is “an agent calls it”.')}
        </p>
    );
}

export function Pill({ testid, kind, Icon, color, label, onRemove, t }: PillProps) {
    return (
        <span
            data-testid={testid}
            data-grant-kind={kind}
            className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full text-xs border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)] max-w-full"
        >
            <Icon size={12} aria-hidden="true" style={{ color }} className="flex-shrink-0" />
            <span className="truncate">{label}</span>
            {onRemove && (
                <button
                    type="button"
                    onClick={onRemove}
                    aria-label={t('skills_studio.canuse.unlink', 'Unlink {name}', { name: label })}
                    className="p-0.5 rounded-full text-[var(--text-tertiary)] hover:text-[var(--error)] transition"
                >
                    <X size={11} aria-hidden="true" />
                </button>
            )}
        </span>
    );
}
