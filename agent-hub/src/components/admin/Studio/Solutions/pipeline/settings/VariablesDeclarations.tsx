import { Plus, Trash2 } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import Button from '../../../../../shared/Button';
import { getDevVariables, putDevVariables, type DeclBody } from './stageSettingsApi';
import {
    VARIABLE_TYPES, settingsError, variableNameProblem,
    type NameProblem, type VariableDecl, type VariableType,
} from './stageSettingsModel';

/**
 * The Solution's variable declarations, in the Dev pipeline area (design 4.2).
 *
 * Declared once in Dev, carried in the release as declarations, valued per stage.
 * A variable of type url or email always steers (where data or mail goes), so
 * its value is the Solution owner's alone and applies on the next redeploy.
 * Secret-like names are refused inline: "store this in a connection".
 */

interface Row { name: string; type: VariableType; choices: string; description: string; required: boolean; steering: boolean }

const emptyRow = (): Row => ({ name: '', type: 'text', choices: '', description: '', required: true, steering: false });
const rowOf = (d: VariableDecl): Row => ({ ...d, choices: (d.choices || []).join(', ') });
const choiceList = (s: string) => s.split(',').map(c => c.trim()).filter(Boolean);

function problemsOf(rows: Row[]): Array<NameProblem | 'choices_missing' | null> {
    return rows.map((r, i) => variableNameProblem(r.name, rows.filter((_, j) => j !== i).map(o => o.name.trim()))
        || (r.type === 'choice' && choiceList(r.choices).length === 0 ? 'choices_missing' : null));
}

const payloadOf = (rows: Row[]): DeclBody => rows.map(r => ({
    name: r.name.trim(), type: r.type, choices: r.type === 'choice' ? choiceList(r.choices) : null,
    description: r.description.trim(), required: r.required, steering: r.steering || r.type === 'url' || r.type === 'email',
}));

const INPUT = 'px-2 py-1.5 rounded-lg text-sm border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]';

export interface VariablesDeclarationsProps {
    solutionId: string;
    /** Editor or owner of Dev; everyone else only reads. */
    canEdit: boolean;
}

export default function VariablesDeclarations({ solutionId, canEdit }: VariablesDeclarationsProps) {
    const { t } = useTranslation();
    const [load, setLoad] = useState<'loading' | 'ok' | 'error'>('loading');
    const [rows, setRows] = useState<Row[]>([]);
    const [saved, setSaved] = useState<string>('[]');
    const [busy, setBusy] = useState(false);
    const [refused, setRefused] = useState<string | null>(null);
    const [asked, setAsked] = useState(0);

    useEffect(() => {
        let alive = true;
        (async () => {
            const res = await getDevVariables(solutionId);
            if (!alive) return;
            if (res.ok) { const next = res.data.map(rowOf); setRows(next); setSaved(JSON.stringify(next)); setLoad('ok'); } else setLoad('error');
        })();
        return () => { alive = false; };
    }, [solutionId, asked]);

    const problems = problemsOf(rows);
    const dirty = JSON.stringify(rows) !== saved;
    const patch = (i: number, p: Partial<Row>) => { setRefused(null); setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r))); };
    const nameText = useCallback((p: NameProblem | 'choices_missing') => ({
        empty: t('stage_settings.decl_name_empty', 'Give the variable a name.'),
        invalid: t('stage_settings.decl_name_invalid', 'Start with a lowercase letter; then lowercase letters, digits and underscores.'),
        // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- an i18n key and message ABOUT secrets, not a secret
        secret: t('stage_settings.decl_name_secret', 'This name looks like a secret. Store secrets in a connection, not in a variable.'),
        duplicate: t('stage_settings.decl_name_duplicate', 'Another variable has this name.'),
        choices_missing: t('stage_settings.decl_choices_missing', 'A choice needs its options.'),
    })[p], [t]);

    const save = async () => {
        setBusy(true); setRefused(null);
        const res = await putDevVariables(solutionId, payloadOf(rows));
        setBusy(false);
        if (res.ok) { const next = res.data.map(rowOf); setRows(next); setSaved(JSON.stringify(next)); return; }
        const err = settingsError(res);
        setRefused(err.kind === 'variable' && err.code === 'variable_secret_name'
            // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- an i18n key and message ABOUT secrets, not a secret
            ? t('stage_settings.decl_name_secret', 'This name looks like a secret. Store secrets in a connection, not in a variable.')
            : err.kind === 'licence' ? t('stage_settings.decl_licence', 'Your plan does not include release pipelines.')
                : t('stage_settings.decl_failed', 'The variables were not saved. Nothing changed.'));
    };

    if (load === 'loading') return <p className="text-sm text-[var(--text-tertiary)]">{t('stage_settings.loading', 'Loading...')}</p>;
    if (load === 'error') {
        return (
            <p className="text-sm text-[var(--text-primary)]" data-testid="decls-unreadable">
                {t('stage_settings.decl_unreadable', 'The variables could not be read, so this is not "there are none".')}{' '}
                <button type="button" className="underline" onClick={() => { setLoad('loading'); setAsked(n => n + 1); }}>{t('stage_settings.retry', 'Try again')}</button>
            </p>
        );
    }

    return (
        <section className="space-y-3" data-testid="variable-declarations">
            <div>
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('stage_settings.decl_title', 'Variables')}</h3>
                <p className="text-xs text-[var(--text-tertiary)]">{t('stage_settings.decl_intro', 'Declared here, carried with each release and given a value per stage. Automations read them as vars.name.')}</p>
            </div>
            {rows.length === 0 && <p className="text-sm text-[var(--text-tertiary)]">{t('stage_settings.decl_none', 'No variables declared yet.')}</p>}
            {rows.map((r, i) => (
                <div key={i} className="rounded-lg p-3 space-y-2 bg-[var(--bg-secondary)]" data-testid="decl-row">
                    <div className="flex items-center gap-2 flex-wrap">
                        <input className={`${INPUT} font-mono flex-1 min-w-[8rem]`} value={r.name} disabled={!canEdit} aria-label={t('stage_settings.decl_name', 'Variable name')}
                            onChange={(e) => patch(i, { name: e.target.value })} />
                        <select className={INPUT} value={r.type} disabled={!canEdit} aria-label={t('stage_settings.decl_type', 'Type')} onChange={(e) => patch(i, { type: e.target.value as VariableType })}>
                            {VARIABLE_TYPES.map(ty => <option key={ty} value={ty}>{ty}</option>)}
                        </select>
                        {canEdit && (
                            <button type="button" aria-label={t('stage_settings.decl_remove', 'Remove variable')} onClick={() => setRows(rows.filter((_, j) => j !== i))} className="p-1 text-[var(--text-tertiary)] hover:text-[var(--error)]">
                                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                        )}
                    </div>
                    {r.type === 'choice' && (
                        <input className={`${INPUT} w-full`} value={r.choices} disabled={!canEdit} placeholder={t('stage_settings.decl_choices_ph', 'Options, separated by commas')}
                            aria-label={t('stage_settings.decl_choices', 'Options')} onChange={(e) => patch(i, { choices: e.target.value })} />
                    )}
                    <input className={`${INPUT} w-full`} value={r.description} disabled={!canEdit} placeholder={t('stage_settings.decl_description_ph', 'What is it for? (optional)')}
                        aria-label={t('stage_settings.decl_description', 'Description')} onChange={(e) => patch(i, { description: e.target.value })} />
                    <div className="flex items-center gap-4 flex-wrap text-xs text-[var(--text-secondary)]">
                        <label className="flex items-center gap-1.5"><input type="checkbox" checked={r.required} disabled={!canEdit} onChange={(e) => patch(i, { required: e.target.checked })} />{t('stage_settings.decl_required', 'Every stage needs a value')}</label>
                        <label className="flex items-center gap-1.5">
                            <input type="checkbox" checked={r.steering || r.type === 'url' || r.type === 'email'} disabled={!canEdit || r.type === 'url' || r.type === 'email'} onChange={(e) => patch(i, { steering: e.target.checked })} />
                            {t('stage_settings.decl_steering', 'Steering: only the Solution owner sets it')}
                        </label>
                    </div>
                    {problems[i] && <p className="text-xs text-[var(--error)]" data-testid="decl-problem">{nameText(problems[i] as NameProblem)}</p>}
                </div>
            ))}
            {refused && <p className="text-sm text-[var(--error)]" role="alert" data-testid="decl-refused">{refused}</p>}
            {canEdit && (
                <div className="flex items-center gap-2">
                    <Button size="sm" variant="secondary" icon={Plus} onClick={() => setRows([...rows, emptyRow()])}>{t('stage_settings.decl_add', 'Add a variable')}</Button>
                    <Button size="sm" disabled={!dirty || busy || problems.some(Boolean)} busy={busy} onClick={save} data-testid="decls-save">{t('stage_settings.decl_save', 'Save variables')}</Button>
                </div>
            )}
        </section>
    );
}
