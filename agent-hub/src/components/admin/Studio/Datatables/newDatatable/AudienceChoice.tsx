import { Building2, User } from 'lucide-react';
import React from 'react';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import ChoiceCard from '../ChoiceCard';
import { ORG_SCOPE_PERMISSION } from './constants';

interface AudienceChoiceProps {
    canChoose: boolean;
    orgScopeWithheld: boolean;
    target: string;
    setTarget: (target: string) => void;
    t: TranslateFn;
}

export default function AudienceChoice({ canChoose, orgScopeWithheld, target, setTarget, t }: AudienceChoiceProps) {
    return canChoose ? (
        <fieldset className="block">
            <legend className="block text-sm font-medium mb-2 text-[var(--text-primary)]">
                {t('datatables.field_audience', 'Who is it for?')}
            </legend>
            <div className="grid grid-cols-2 gap-2">
                <ChoiceCard
                    name="datatable-scope"
                    icon={<Building2 className="w-3.5 h-3.5 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />}
                    checked={target === 'organisation'}
                    onChange={() => setTarget('organisation')}
                    title={t('datatables.scope_org', 'Your organisation')}
                    blurb={t('datatables.scope_org_blurb', 'You decide afterwards who may read or change the rows. Automations your colleagues own can use it.')}
                />
                <ChoiceCard
                    name="datatable-scope"
                    icon={<User className="w-3.5 h-3.5 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />}
                    checked={target === 'personal'}
                    onChange={() => setTarget('personal')}
                    title={t('datatables.scope_personal', 'This account only')}
                    blurb={t('datatables.scope_personal_blurb', 'Only this account can see the rows — not colleagues, not administrators. It cannot be shared later.')}
                />
            </div>
        </fieldset>
    ) : (
        <p className="text-[11px] px-3 py-2 rounded-lg flex items-start gap-2 bg-[var(--bg-primary)] text-[var(--text-secondary)]">
            <User className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
            <span>
                {t('datatables.scope_personal_blurb', 'Only this account can see the rows — not colleagues, not administrators. It cannot be shared later.')}
                {orgScopeWithheld && (
                    <>
                        {' '}
                        {/* The sentence carries the words; the title
                            keeps the exact permission id, so the
                            administrator this gets forwarded to has
                            the string to grant and does not have to
                            guess it back out of the copy. */}
                        <span title={ORG_SCOPE_PERMISSION} className="underline decoration-dotted">
                            {t('datatables.scope_org_not_permitted', 'Making one for the whole organisation needs a permission this account does not have — an administrator grants it under Organisation → Roles.')}
                        </span>
                    </>
                )}
            </span>
        </p>
    );
}
