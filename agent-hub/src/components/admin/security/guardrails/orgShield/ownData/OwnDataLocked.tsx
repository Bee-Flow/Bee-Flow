import { Lock } from 'lucide-react';
import React from 'react';

import EmptyState from '../../../../../shared/EmptyState';
import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import LicenceLock from '../parts/LicenceLock';
import OwnDataIntro from './OwnDataIntro';
import type { CustomDataType, ShieldLists } from './ownDataModel';
import { switchesFor } from './ownDataModel';
import OwnDataRow from './OwnDataRow';
import OwnDataTable from './OwnDataTable';
import { Card } from './ui';

/**
 * "Your own data" on a plan without it.
 *
 * Words and patterns an organisation added before this tab existed were
 * migrated into types and are still enforced, so they are shown, read-only.
 * The one change allowed is removing one: taking something OUT of the shield
 * is never an upgrade question, and keeping an admin from deleting their own
 * old entry would hold their data hostage to a licence.
 */
export function OwnDataLocked({
    types, lists, canBlockExternal, upgradeUrl, readOnly, note = null, onRemove, t,
}: {
    types: CustomDataType[];
    lists: ShieldLists;
    canBlockExternal: boolean;
    upgradeUrl?: string;
    readOnly: boolean;
    note?: string | null;
    onRemove: (id: string) => void;
    t: TranslateFn;
}) {
    const removable = (type: CustomDataType) => !readOnly && (type.legacy || type.origin === 'migrated');
    return (
        <Card className="flex flex-col min-h-0 overflow-hidden">
            <div className="flex flex-col gap-2.5 px-[22px] pt-5 pb-4">
                <OwnDataIntro t={t}>
                    <LicenceLock upgradeUrl={upgradeUrl} t={t}>
                        {t('shield_data.locked_banner', 'Your own data is part of Enterprise. With Enterprise you can add your own kinds of data, test them and tune them.')}
                    </LicenceLock>
                </OwnDataIntro>
                {note && <p role="status" className="m-0 text-xs font-medium text-[var(--success-ink)]">{note}</p>}
            </div>
            {types.length === 0 ? (
                <EmptyState
                    className="!h-auto !py-8"
                    icon={<Lock className="w-7 h-7" />}
                    title={t('shield_data.locked_empty', 'Add your own kinds of data with Enterprise')}
                />
            ) : (
                <>
                    <p className="px-[22px] pb-3 m-0 text-xs leading-relaxed text-[var(--text-secondary)]">
                        {t('shield_data.locked_migrated', 'These words and patterns were added earlier. They are still hidden. You can see them here; changing them needs Enterprise.')}
                    </p>
                    <OwnDataTable caption={t('shield_data.table_caption', 'Your own kinds of data, how each is found, and where it is hidden.')} t={t}>
                        {types.map(type => (
                            <OwnDataRow
                                key={type.id}
                                type={type}
                                switches={switchesFor(lists, type.id)}
                                onSwitch={() => undefined}
                                licensed={false}
                                canBlockExternal={canBlockExternal}
                                readOnly
                                expandable
                                actions={removable(type) ? { onRemove: () => onRemove(type.id) } : {}}
                                t={t}
                            />
                        ))}
                    </OwnDataTable>
                </>
            )}
        </Card>
    );
}

export default OwnDataLocked;
