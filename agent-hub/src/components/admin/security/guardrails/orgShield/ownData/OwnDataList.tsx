import { Plus, TriangleAlert } from 'lucide-react';
import React from 'react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import OwnDataIntro from './OwnDataIntro';
import type { CustomDataType, ShieldLists, SwitchCol } from './ownDataModel';
import { LIMITS, switchesFor } from './ownDataModel';
import OwnDataRow from './OwnDataRow';
import OwnDataTable from './OwnDataTable';
import { Card, DarkButton, Note } from './ui';

/**
 * The Enterprise view of "Your own data" once the org has types: all of
 * them in one table, with the same three switches as the built-in kinds.
 * An org without any gets the starters instead (OwnDataLanding).
 */

export interface TypeErrorEntry { id: string; field?: string; code?: string; message?: string }

interface OwnDataListProps {
    types: CustomDataType[];
    lists: ShieldLists;
    canBlockExternal: boolean;
    readOnly: boolean;
    routines: boolean;
    guardDown: boolean;
    typeErrors: TypeErrorEntry[];
    note: string | null;
    onAdd: () => void;
    onEdit: (id: string) => void;
    onTest: (id: string) => void;
    onRemove: (id: string) => void;
    onSwitch: (id: string, col: SwitchCol, on: boolean) => void;
    t: TranslateFn;
}

export function OwnDataList(props: OwnDataListProps) {
    const {
        types, lists, canBlockExternal, readOnly, routines, guardDown, typeErrors, note, onAdd, onEdit, onTest, onRemove, onSwitch, t,
    } = props;
    const errorFor = (id: string) => typeErrors.find(e => e.id === id)?.message || null;
    const aiDown = guardDown && types.some(x => x.method === 'ai');
    const add = readOnly ? null : (
        <DarkButton Icon={Plus} onClick={onAdd} disabled={types.length >= LIMITS.types} className="h-8 px-3 rounded-[8px] text-xs">
            {t('shield_data.add_type', 'Add a type')}
        </DarkButton>
    );

    return (
        <Card className="flex flex-col min-h-0 overflow-hidden">
            <div className="flex flex-col gap-2.5 px-[22px] pt-5 pb-4">
                <OwnDataIntro routines={routines} action={add} t={t} />
                {note && <p role="status" className="m-0 text-xs font-medium text-[var(--success-ink)]">{note}</p>}
                {aiDown && (
                    <Note Icon={TriangleAlert} tone="warn">
                        {t('shield_data.ai_down_note', 'Types recognised by AI find nothing while the detection service is not running. Lists of words and fixed formats keep working.')}
                    </Note>
                )}
            </div>
            <OwnDataTable caption={t('shield_data.table_caption', 'Your own kinds of data, how each is found, and where it is hidden.')} t={t}>
                {types.map(type => (
                    <OwnDataRow
                        key={type.id}
                        type={type}
                        switches={switchesFor(lists, type.id)}
                        onSwitch={(col, on) => onSwitch(type.id, col, on)}
                        licensed
                        canBlockExternal={canBlockExternal}
                        readOnly={readOnly}
                        error={errorFor(type.id)}
                        actions={readOnly ? {} : {
                            onTest: () => onTest(type.id),
                            onEdit: () => onEdit(type.id),
                            onRemove: () => onRemove(type.id),
                        }}
                        t={t}
                    />
                ))}
            </OwnDataTable>
        </Card>
    );
}

export default OwnDataList;
