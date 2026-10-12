import { Lock } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import Button from '../../../../../shared/Button';
import { canEditValue, isSteering, valuePending, valueToInput, type VariableDecl, type VariableValue } from './stageSettingsModel';

/**
 * The values of the Solution's variables for ONE stage (design 4.2).
 *
 * A non-steering value is live the moment it is saved. A steering value (type
 * url or email, or flagged by the author) decides where data or mail goes: only
 * the Solution owner may edit it, and it applies with the next redeploy, which
 * in Production with the gate on passes the approval. An editor sees it,
 * disabled, with the reason.
 */

const INPUT = 'w-full px-2 py-1.5 rounded-lg text-sm border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)] disabled:opacity-60';

export interface VariablesSectionProps {
    load: 'loading' | 'ok' | 'error';
    decls: VariableDecl[];
    values: VariableValue[];
    role: string;
    draft: Record<string, string>;
    onDraft: (name: string, text: string | undefined) => void;
    errors: Record<string, string>;
    saving: boolean;
    onSave: () => void;
    onRetry: () => void;
}

export default function VariablesSection(p: VariablesSectionProps) {
    const { t } = useTranslation();
    if (p.load === 'loading') return <p className="text-sm text-[var(--text-tertiary)]">{t('stage_settings.loading', 'Loading...')}</p>;
    if (p.load === 'error') {
        return (
            <p className="text-sm text-[var(--text-primary)]" data-testid="variables-unreadable">
                {t('stage_settings.vars_unreadable', 'The variables of this stage could not be read, so this is not "there are none".')}{' '}
                <button type="button" className="underline" onClick={p.onRetry}>{t('stage_settings.retry', 'Try again')}</button>
            </p>
        );
    }
    if (p.decls.length === 0) {
        return <p className="text-sm text-[var(--text-tertiary)]" data-testid="variables-none">{t('stage_settings.vars_none', 'This Solution declares no variables. Declare them in Dev, on the Pipeline tab.')}</p>;
    }
    const dirty = Object.keys(p.draft).length > 0;
    return (
        <div className="space-y-3" data-testid="settings-variables">
            {p.decls.map(decl => {
                const stored = p.values.find(v => v.name === decl.name);
                const editable = canEditValue(decl, p.role);
                const steering = isSteering(decl);
                const text = decl.name in p.draft ? p.draft[decl.name] : valueToInput(stored?.value);
                const pending = valuePending(decl, stored) || (steering && decl.name in p.draft);
                const set = (v: string) => p.onDraft(decl.name, v);
                const label = `${decl.name}${decl.required ? '' : ` (${t('stage_settings.vars_optional', 'optional')})`}`;
                return (
                    <div key={decl.name} className="rounded-lg p-3 space-y-1.5 bg-[var(--bg-secondary)]" data-testid={`variable-${decl.name}`} data-steering={steering ? 'true' : 'false'}>
                        <div className="flex items-center gap-2 flex-wrap">
                            <label htmlFor={`var-${decl.name}`} className="text-sm font-medium font-mono text-[var(--text-primary)]">{label}</label>
                            {steering && (
                                <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)]" data-testid={`variable-steering-${decl.name}`}>
                                    <Lock className="w-3 h-3" aria-hidden="true" />{t('stage_settings.vars_steering', 'Steering')}
                                </span>
                            )}
                            {decl.required && !stored && !(decl.name in p.draft) && (
                                <span className="text-[11px] text-[var(--warning)]">{t('stage_settings.vars_needs_value', 'Needs a value')}</span>
                            )}
                        </div>
                        {decl.description && <p className="text-xs text-[var(--text-tertiary)]">{decl.description}</p>}
                        {decl.type === 'choice' || decl.type === 'boolean' ? (
                            <select id={`var-${decl.name}`} className={INPUT} disabled={!editable} value={text} onChange={(e) => set(e.target.value)}>
                                <option value="">{t('stage_settings.vars_unset', '- not set -')}</option>
                                {(decl.type === 'boolean' ? ['true', 'false'] : decl.choices || []).map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                        ) : (
                            <input id={`var-${decl.name}`} className={INPUT} disabled={!editable} value={text}
                                type={decl.type === 'number' ? 'number' : decl.type === 'email' ? 'email' : 'text'} onChange={(e) => set(e.target.value)} />
                        )}
                        {steering && !editable && (
                            <p className="text-xs text-[var(--text-tertiary)]" data-testid={`variable-locked-${decl.name}`}>
                                {t('stage_settings.vars_owner_only', 'Only the owner of this Solution can change this value: it decides where data or mail goes.')}
                            </p>
                        )}
                        {pending && (
                            <p className="text-xs text-[var(--text-secondary)]" data-testid={`variable-pending-${decl.name}`}>
                                {t('stage_settings.vars_applies_next', 'Applies on the next redeploy.')}
                                {stored && stored.appliedValue !== null && stored.appliedValue !== undefined && ` ${t('stage_settings.vars_running', 'Running now: {value}', { value: String(stored.appliedValue) })}`}
                            </p>
                        )}
                        {p.errors[decl.name] && <p className="text-xs text-[var(--error)]" data-testid={`variable-error-${decl.name}`}>{p.errors[decl.name]}</p>}
                    </div>
                );
            })}
            <Button size="sm" disabled={!dirty || p.saving} busy={p.saving} onClick={p.onSave} data-testid="variables-save">{t('stage_settings.vars_save', 'Save values')}</Button>
        </div>
    );
}
