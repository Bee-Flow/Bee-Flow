import { ArrowRight, Plus } from 'lucide-react';
import React, { useId, useState } from 'react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import OwnDataIntro, { SectionLabel } from './OwnDataIntro';
import type { CustomDataType } from './ownDataModel';
import { LIMITS } from './ownDataModel';
import type { Starter, StarterId } from './starters';
import { STARTERS, starterPlaceholder } from './starters';
import { Card, DarkButton } from './ui';

/**
 * "Your own data" before the org has any: four examples that open the wizard
 * already filled in, and a sentence field that opens it with the admin's own
 * description. Both only open the wizard; nothing is added, sent or saved
 * from here.
 */

function StarterTile({
    starter, placeholder, disabled, onPick, t,
}: { starter: Starter; placeholder: string | null; disabled: boolean; onPick: () => void; t: TranslateFn }) {
    const id = useId();
    const { Icon } = starter;
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onPick}
            // The name is the title alone, so "Project code names" is what a
            // screen reader (and a test) finds; the hint and example describe it.
            aria-labelledby={`${id}-title`}
            aria-describedby={`${id}-desc`}
            className={'flex flex-col gap-2 p-3.5 rounded-[10px] border text-left cursor-pointer bg-[var(--bg-card)] border-[var(--border-default)] '
                + 'hover:bg-[var(--bg-secondary)] disabled:opacity-50 disabled:cursor-not-allowed '
                + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--info)] '
                + (starter.open ? 'border-dashed' : '')}
        >
            <span id={`${id}-title`} className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-primary)]">
                <Icon className="w-3.5 h-3.5 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
                {t(...starter.label)}
            </span>
            <span id={`${id}-desc`} className="flex flex-col gap-2">
                <span className="text-xs text-[var(--text-secondary)]">{t(...starter.hint)}</span>
                {/* The spaces keep the description readable as one sentence;
                    between flex items they take no room. */}
                {' '}
                {starter.example && (
                    <span className="flex items-center gap-1.5 flex-wrap font-mono text-[11px] text-[var(--text-secondary)]">
                        <span>{t(...starter.example)}</span>
                        {placeholder && (
                            <>
                                {' '}
                                <ArrowRight className="w-[11px] h-[11px] shrink-0" aria-hidden="true" />
                                <span className="sr-only">{t('shield_data.starter_becomes', 'becomes')}</span>
                                {' '}
                                <span className="font-semibold text-[var(--info-ink)]">{placeholder}</span>
                            </>
                        )}
                    </span>
                )}
            </span>
        </button>
    );
}

/** "Or describe it": a sentence that becomes the new type's description. */
function DescribeRow({ disabled, onCreate, t }: { disabled: boolean; onCreate: (text: string) => void; t: TranslateFn }) {
    const id = useId();
    const [text, setText] = useState('');
    const ready = !disabled && text.trim() !== '';
    const submit = () => { if (ready) onCreate(text); };
    return (
        <div className="flex flex-col gap-2">
            <SectionLabel htmlFor={id}>{t('shield_data.describe_label', 'Or describe it')}</SectionLabel>
            <div className="flex gap-2 flex-wrap @min-[480px]/pane:flex-nowrap">
                <input
                    id={id}
                    type="text"
                    value={text}
                    disabled={disabled}
                    maxLength={LIMITS.description}
                    onChange={e => setText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
                    placeholder={t('shield_data.describe_placeholder', 'e.g. Our customer numbers start with KC- followed by four digits')}
                    className="flex-1 min-w-0 h-10 px-3 rounded-[9px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] disabled:opacity-50"
                />
                <DarkButton Icon={Plus} onClick={submit} disabled={!ready} className="h-10 px-4 rounded-[9px] text-[13px]">
                    {t('shield_data.describe_create', 'Create type')}
                </DarkButton>
            </div>
        </div>
    );
}

export function OwnDataLanding({
    types, readOnly, routines, note, onStart, onDescribe, t,
}: {
    types: CustomDataType[];
    readOnly: boolean;
    routines: boolean;
    note: string | null;
    onStart: (starter: StarterId) => void;
    onDescribe: (text: string) => void;
    t: TranslateFn;
}) {
    const labelId = useId();
    const disabled = readOnly || types.length >= LIMITS.types;
    return (
        <Card className="flex flex-col gap-[18px] px-[22px] py-5">
            <OwnDataIntro routines={routines} t={t} />
            {note && <p role="status" className="m-0 -mt-2 text-xs font-medium text-[var(--success-ink)]">{note}</p>}
            <div role="group" aria-labelledby={labelId} className="flex flex-col gap-2">
                <SectionLabel id={labelId}>{t('shield_data.starters_label', 'Start from an example')}</SectionLabel>
                <div className="grid gap-2.5 grid-cols-1 @min-[560px]/pane:grid-cols-2">
                    {STARTERS.map(s => (
                        <StarterTile
                            key={s.id}
                            starter={s}
                            placeholder={starterPlaceholder(s.id, types, t)}
                            disabled={disabled}
                            onPick={() => onStart(s.id)}
                            t={t}
                        />
                    ))}
                </div>
            </div>
            <DescribeRow disabled={disabled} onCreate={onDescribe} t={t} />
        </Card>
    );
}

export default OwnDataLanding;
