import { AppWindow, X } from 'lucide-react';
import { useId } from 'react';

import type { ExemptionApp } from '@/api/queries/shieldExemptionApps';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { ToolClassPolicy } from '../orgShieldDoc';
import type { MatrixKind, ToolColumn } from './categoryMatrixModel';
import MatrixCell from './MatrixCell';

/**
 * "Exceptions per app", under the kinds-of-data table.
 *
 * A tool column's list holds for every tool in it. An exception narrows it
 * for one app: "Outlook may receive person names and e-mail addresses; IBANs
 * stay held back for Outlook too". Per column the admin picks an app the
 * organisation has, then which of the kinds that column HOLDS BACK it may
 * receive. Nothing else is offered: a kind that is not held back has nothing
 * to except, and the hard kinds (secrets, identity-document numbers) are never
 * offered; the server refuses them as well (core/privacy/toolPiiExemptions.mts).
 */

/** Mirrors HARD_BLOCKED_CATEGORIES on the server. */
const HARD_KINDS = new Set(['ApiKeyOrSecret', 'PassportNumber', 'DriversLicenseNumber']);

const COLUMN_TITLE: Record<ToolColumn, [string, string]> = {
    external: ['shield_exemptions.class_external', 'Outside tools'],
    internal: ['shield_exemptions.class_internal', 'Own server'],
};

interface AppExemptionsCardProps {
    toolPolicy: Record<ToolColumn, ToolClassPolicy>;
    /** The built-in kinds, as the table shows them. */
    categories: MatrixKind[];
    /** null while loading or after a failure. */
    apps: ExemptionApp[] | null;
    appsFailed: boolean;
    canBlockExternal: boolean;
    readOnly: boolean;
    onSet: (cls: ToolColumn, appId: string, ids: string[] | null) => void;
    t: TranslateFn;
}

type ColumnProps = Omit<AppExemptionsCardProps, 'toolPolicy' | 'canBlockExternal' | 'appsFailed'> & {
    col: ToolColumn;
    policy: ToolClassPolicy;
};

function AppRow({ col, appId, label, held, allowed, readOnly, onSet, t }: {
    col: ToolColumn; appId: string; label: string; held: MatrixKind[]; allowed: string[];
    readOnly: boolean; onSet: AppExemptionsCardProps['onSet']; t: TranslateFn;
}) {
    const toggle = (id: string, on: boolean) => onSet(col, appId, on ? [...allowed, id] : allowed.filter(x => x !== id));
    return (
        <li className="flex flex-col gap-1.5 py-2 border-t border-[var(--border-subtle)] first:border-t-0">
            <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-[var(--text-primary)]">
                    {t('shield_exemptions.may_receive', '{app} may receive', { app: label })}
                </span>
                <span className="flex-1" />
                <button
                    type="button"
                    disabled={readOnly}
                    onClick={() => onSet(col, appId, null)}
                    aria-label={t('shield_exemptions.remove', 'Remove the exception for {app}', { app: label })}
                    className="p-1 rounded-[6px] text-[var(--text-tertiary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
                >
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {held.map(kind => (
                    <span key={kind.id} className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                        <MatrixCell
                            checked={allowed.includes(kind.id)}
                            disabled={readOnly}
                            name={t('shield_exemptions.category_for_app', '{kind} for {app}', { kind: kind.label, app: label })}
                            onChange={on => toggle(kind.id, on)}
                        />
                        <span aria-hidden="true">{kind.label}</span>
                    </span>
                ))}
            </div>
        </li>
    );
}

function ExemptionColumn({ col, policy, categories, apps, readOnly, onSet, t }: ColumnProps) {
    const titleId = useId();
    const title = t(...COLUMN_TITLE[col]);
    const blocked = new Set(policy.blockCategories || []);
    const held = categories.filter(k => blocked.has(k.id) && !HARD_KINDS.has(k.id));
    const entries = Object.entries(policy.appExemptions || {});
    const labelOf = (id: string) => apps?.find(a => a.id === id)?.label || id;
    const choices = (apps || []).filter(a => a.classes.includes(col) && !entries.some(([id]) => id === a.id));
    return (
        <div role="group" aria-labelledby={titleId} className="flex flex-col gap-2 min-w-0">
            <h5 id={titleId} className="m-0 text-xs font-semibold uppercase tracking-[0.05em] text-[var(--text-secondary)]">{title}</h5>
            {held.length === 0 ? (
                <p className="m-0 text-xs text-[var(--text-tertiary)]">
                    {t('shield_exemptions.none_blocked', 'Nothing is held back in this column, so there is nothing to make an exception for.')}
                </p>
            ) : (
                <>
                    {entries.length === 0 ? (
                        <p className="m-0 text-xs text-[var(--text-tertiary)]">
                            {t('shield_exemptions.empty', 'No exceptions yet: every app in this column is held to the whole list.')}
                        </p>
                    ) : (
                        <ul className="m-0 p-0 list-none">
                            {entries.map(([appId, allowed]) => (
                                <AppRow key={appId} col={col} appId={appId} label={labelOf(appId)} held={held} allowed={allowed} readOnly={readOnly} onSet={onSet} t={t} />
                            ))}
                        </ul>
                    )}
                    {apps && choices.length === 0 && entries.length === 0 ? (
                        <p className="m-0 text-xs text-[var(--text-tertiary)]">
                            {t('shield_exemptions.no_apps', "None of your organisation's apps can get an exception in this column.")}
                        </p>
                    ) : (
                        <select
                            value=""
                            disabled={readOnly || !apps || choices.length === 0}
                            onChange={e => { if (e.target.value) onSet(col, e.target.value, []); }}
                            aria-label={t('shield_exemptions.pick_app', 'Choose an app')}
                            className="self-start h-[30px] px-2 rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-card)] text-xs text-[var(--text-primary)] disabled:opacity-50"
                        >
                            <option value="">{t('shield_exemptions.add', 'Add app')}</option>
                            {choices.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
                        </select>
                    )}
                </>
            )}
        </div>
    );
}

export default function AppExemptionsCard({ toolPolicy, canBlockExternal, appsFailed, ...rest }: AppExemptionsCardProps) {
    const { t } = rest;
    const columns: ToolColumn[] = canBlockExternal ? ['external', 'internal'] : ['internal'];
    return (
        <section className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] shadow-[var(--shadow-sm)] px-[18px] py-4 flex flex-col gap-3 min-w-0">
            <div className="flex gap-3 min-w-0">
                <AppWindow className="w-[18px] h-[18px] shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
                <div className="flex flex-col gap-1 min-w-0">
                    <h4 className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">
                        {t('shield_exemptions.title', 'Exceptions per app')}
                    </h4>
                    <p className="m-0 text-xs leading-[18px] text-[var(--text-secondary)]">
                        {t('shield_exemptions.explain', 'An exception lets one app receive kinds of data this column holds back from every other tool. The AI still only sees placeholders; the real values go to that app alone.')}
                    </p>
                    <p className="m-0 text-xs leading-[18px] text-[var(--text-tertiary)]">
                        {t('shield_exemptions.hard_note', 'API keys and secrets, passport numbers and driving licence numbers stay held back for every app.')}
                    </p>
                    {appsFailed && (
                        <p className="m-0 text-xs text-[var(--warning-ink)]">
                            {t('shield_exemptions.load_error', 'The list of apps could not be loaded. Existing exceptions still apply.')}
                        </p>
                    )}
                </div>
            </div>
            <div className="grid gap-4 grid-cols-1 @min-[720px]/pane:grid-cols-2">
                {columns.map(col => <ExemptionColumn key={col} col={col} policy={toolPolicy[col]} {...rest} />)}
            </div>
        </section>
    );
}
