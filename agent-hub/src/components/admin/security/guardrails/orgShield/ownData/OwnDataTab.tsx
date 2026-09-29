import React, { useState } from 'react';

import useConfirm from '../../../../../shared/useConfirm';
import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import type { ToolPiiPolicy } from '../orgShieldDoc';
import AllowTermsChips from '../parts/AllowTermsChips';
import type { TypeErrorEntry } from './OwnDataList';
import OwnDataLanding from './OwnDataLanding';
import OwnDataList from './OwnDataList';
import OwnDataLocked from './OwnDataLocked';
import type {
    CustomDataType, ShieldLists, SwitchCol, TestsDoc,
} from './ownDataModel';
import { switchesFor, toDraft, toggleId } from './ownDataModel';
import type { StarterId } from './starters';
import { starterInit } from './starters';
import type { WizardCommit, WizardInit } from './useTypeWizard';
import type { ConfirmFn } from './wizard/stepTypes';
import TypeWizard from './wizard/TypeWizard';

/**
 * "Your own data": the org's own kinds of data, beside the built-in ones,
 * and the never-hidden list next to them.
 *
 * Owns only the choice between the starters, the list, the wizard and the
 * locked view, and the three edits that reach the shield form: add or
 * replace a type, remove one, and flip one of its switches. The switches are
 * the type's id in the existing category lists (`piiDetectionCategories` and
 * the two tool lists), so a type is saved, clamped and enforced exactly like
 * a built-in kind. Nothing here writes to the server; the normal Save does.
 *
 * The never-hidden card is shown in every state but the wizard, locked or
 * not: the server accepts those exceptions on every plan.
 */

export interface OwnDataFields extends ShieldLists {
    customDataTypes: CustomDataType[];
    setCustomDataTypes: (v: CustomDataType[]) => void;
    customDataTests: TestsDoc | null;
    setCustomDataTests: (v: TestsDoc | null) => void;
    setPiiCategories: (v: string[]) => void;
    toolPiiPolicy: ToolPiiPolicy;
    piiAllowTerms: string[];
    setPiiAllowTerms: (v: string[]) => void;
    piiAllowPublicOrgs: boolean;
    setPiiAllowPublicOrgs: (v: boolean) => void;
    /** Read as `!== false`, like the rest of the shield. */
    applyToAutomations?: boolean;
}

interface OwnDataTabProps {
    f: OwnDataFields;
    orgId: string;
    licence: { canUseCustomData: boolean; canUseWebSearchGuard: boolean; upgradeUrl?: string };
    guard: { configured: boolean; reachable: boolean } | null;
    readOnly: boolean;
    typeErrors: TypeErrorEntry[];
    toggleToolPiiCat: (cls: 'external' | 'internal', id: string, on: boolean) => void;
    setToolPiiCats: (cls: 'external' | 'internal', ids: string[]) => void;
    t: TranslateFn;
}

/**
 * The three edits this tab makes to the shield form. Plain functions over
 * `f`: a type, its tests and its three list entries always move together,
 * so removing a type can never leave its id behind in a list.
 */
function ownDataEdits(
    f: OwnDataFields,
    { toggleToolPiiCat, setToolPiiCats, canBlockExternal }: Pick<OwnDataTabProps, 'toggleToolPiiCat' | 'setToolPiiCats'> & { canBlockExternal: boolean },
) {
    const types = f.customDataTypes || [];
    const ext = f.toolPiiPolicy.external.blockCategories;
    const int = f.toolPiiPolicy.internal.blockCategories;
    return {
        setSwitch(id: string, col: SwitchCol, on: boolean) {
            if (col === 'detect') f.setPiiCategories(toggleId(f.piiCategories, id, on));
            else toggleToolPiiCat(col, id, on);
        },
        /** @returns whether the type already existed (an update, not an add) */
        commit({ type, tests, apply }: WizardCommit): boolean {
            const exists = types.some(x => x.id === type.id);
            f.setCustomDataTypes(exists ? types.map(x => (x.id === type.id ? type : x)) : [...types, type]);
            if (f.customDataTests !== null) f.setCustomDataTests({ ...f.customDataTests, [type.id]: tests });
            f.setPiiCategories(toggleId(f.piiCategories, type.id, apply.detect));
            setToolPiiCats('external', toggleId(ext, type.id, canBlockExternal && apply.external));
            setToolPiiCats('internal', toggleId(int, type.id, apply.internal));
            return exists;
        },
        remove(id: string) {
            f.setCustomDataTypes(types.filter(x => x.id !== id));
            if (f.customDataTests?.[id]) {
                const { [id]: _gone, ...rest } = f.customDataTests;
                f.setCustomDataTests(rest);
            }
            f.setPiiCategories(f.piiCategories.filter(x => x !== id));
            setToolPiiCats('external', ext.filter(x => x !== id));
            setToolPiiCats('internal', int.filter(x => x !== id));
        },
    };
}

/** The tab's state: which wizard is open, the last note, and the actions that set them. */
function useOwnDataTab({ f, licence, guard, toggleToolPiiCat, setToolPiiCats, t }: OwnDataTabProps) {
    const { confirm: rawConfirm, confirmDialog } = useConfirm();
    const confirm: ConfirmFn = async opts => (await rawConfirm(opts)) === true;
    const [wizard, setWizard] = useState<{ init: WizardInit; key: number } | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const types = f.customDataTypes || [];
    const canBlockExternal = licence.canUseWebSearchGuard;
    const guardDown = !!guard && (guard.configured === false || guard.reachable === false);
    const lists: ShieldLists = { piiCategories: f.piiCategories, toolPiiPolicy: f.toolPiiPolicy };
    const edits = ownDataEdits(f, { toggleToolPiiCat, setToolPiiCats, canBlockExternal });

    const open = (init: WizardInit) => { setNote(null); setWizard({ init, key: Date.now() }); };
    const openExisting = (id: string, step: 0 | 1) => {
        const type = types.find(x => x.id === id);
        if (!type) return;
        open({ mode: 'edit', type: toDraft(type), tests: f.customDataTests?.[id] || null, apply: switchesFor(lists, id), step });
    };
    const commit = (c: WizardCommit) => {
        const exists = edits.commit(c);
        setWizard(null);
        setNote(exists
            ? t('shield_data.updated_note', 'Updated. Press Save to keep it.')
            : t('shield_data.added_note', 'Added. Press Save to switch it on.'));
    };
    const remove = async (id: string) => {
        const type = types.find(x => x.id === id);
        if (!type) return;
        const ok = await confirm({
            title: t('shield_data.remove_title', 'Remove “{name}”?', { name: type.name }),
            description: t('shield_data.remove_desc', 'It is no longer hidden once you press Save. Its test sentences are removed too.'),
            confirmLabel: t('common.remove', 'Remove'),
            cancelLabel: t('common.cancel', 'Cancel'),
            destructive: true,
        });
        if (!ok) return;
        edits.remove(id);
        setNote(t('shield_data.removed_note', 'Removed. Press Save to make it final.'));
    };
    return {
        types, lists, canBlockExternal, guardDown, note, wizard, confirm, confirmDialog, open, openExisting, commit, remove,
        closeWizard: () => setWizard(null),
        setSwitch: edits.setSwitch,
    };
}

type TabState = ReturnType<typeof useOwnDataTab>;

/** The left column: locked, the starters, or the list. */
function TypesPane({ s, props }: { s: TabState; props: OwnDataTabProps }) {
    const { f, licence, readOnly, typeErrors, t } = props;
    const { types, lists, canBlockExternal, note } = s;
    const routines = f.applyToAutomations !== false;
    if (!licence.canUseCustomData) {
        return (
            <OwnDataLocked
                types={types} lists={lists} canBlockExternal={canBlockExternal} upgradeUrl={licence.upgradeUrl}
                readOnly={readOnly} note={note} onRemove={s.remove} t={t}
            />
        );
    }
    const start = (starter: StarterId, description?: string) => (
        s.open(starterInit(starter, types, canBlockExternal, t, description))
    );
    if (types.length === 0) {
        return (
            <OwnDataLanding
                types={types} readOnly={readOnly} routines={routines} note={note}
                onStart={starter => start(starter)}
                onDescribe={text => start('other', text)}
                t={t}
            />
        );
    }
    return (
        <OwnDataList
            types={types} lists={lists} canBlockExternal={canBlockExternal} readOnly={readOnly} routines={routines}
            guardDown={s.guardDown}
            typeErrors={typeErrors} note={note}
            onAdd={() => start('other')}
            onEdit={id => s.openExisting(id, 0)}
            onTest={id => s.openExisting(id, 1)}
            onRemove={s.remove}
            onSwitch={s.setSwitch}
            t={t}
        />
    );
}

export function OwnDataTab(props: OwnDataTabProps) {
    const { f, orgId, licence, readOnly, t } = props;
    const s = useOwnDataTab(props);

    // The wizard keeps the full width: its test bench needs the room.
    if (licence.canUseCustomData && s.wizard) {
        return (
            <div className="flex flex-col gap-3 min-h-0">
                <TypeWizard
                    key={s.wizard.key}
                    init={s.wizard.init}
                    ctx={{ orgId, types: s.types, guardDown: s.guardDown, canBlockExternal: s.canBlockExternal, upgradeUrl: licence.upgradeUrl }}
                    confirm={s.confirm}
                    onCommit={s.commit}
                    onCancel={s.closeWizard}
                    t={t}
                />
                {s.confirmDialog}
            </div>
        );
    }
    // Side by side only when the PANE is wide enough (a container query, not
    // the screen): the list's seven columns need the width, so on a laptop the
    // never-hidden card goes under it, at a width that still reads as a card.
    return (
        <div className="flex flex-col gap-3 min-h-0">
            <div className="grid gap-4 items-start @min-[1240px]/pane:grid-cols-[minmax(0,1fr)_minmax(320px,420px)] @min-[1480px]/pane:grid-cols-[minmax(0,1fr)_460px]">
                <div className="min-w-0">
                    <TypesPane s={s} props={props} />
                </div>
                <div className="min-w-0 @max-[1239px]/pane:max-w-[720px]">
                <AllowTermsChips
                    terms={f.piiAllowTerms || []}
                    onChange={f.setPiiAllowTerms}
                    publicOrgs={f.piiAllowPublicOrgs !== false}
                    onChangePublicOrgs={f.setPiiAllowPublicOrgs}
                    readOnly={readOnly}
                    t={t}
                />
                </div>
            </div>
            {s.confirmDialog}
        </div>
    );
}

export default OwnDataTab;
