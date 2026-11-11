import useTranslation from '@/hooks/useTranslation';
import FormField from '@/components/shared/FormField';
import { INPUT_CLS } from '../inspector/panels/kit';
import type { DefinitionVariable } from '../inspector/appDefinition';

/**
 * The schema 3 keys of one variable (shared/appDefinition/variableScopes.mjs): where its
 * value lives (the whole app, one screen, or a formula) and, for an app value, whether a
 * signed-in viewer's browser keeps it across a reload. Every choice writes only the keys it
 * needs and clears the others, so a variable left on "set by the app" keeps its bytes.
 */

type Kind = 'app' | 'screen' | 'derived';
type Persist = 'none' | 'session' | 'local';

interface VariableBehaviourProps {
    variable: DefinitionVariable;
    onChange: (changes: Partial<DefinitionVariable>) => void;
    disabled?: boolean;
}

function kindOf(variable: DefinitionVariable): Kind {
    const derived = variable.derived as { expr?: unknown } | undefined;
    if (derived && typeof derived.expr === 'string') return 'derived';
    return variable.scope === 'screen' ? 'screen' : 'app';
}

function persistOf(variable: DefinitionVariable): Persist {
    return variable.persist === 'session' || variable.persist === 'local' ? variable.persist : 'none';
}

/** The keys a choice of kind writes. A new formula starts as "null", so the starting value shows until it is written. */
function changesForKind(kind: Kind): Partial<DefinitionVariable> {
    if (kind === 'derived') return { derived: { expr: 'null' }, scope: undefined, persist: undefined };
    if (kind === 'screen') return { scope: 'screen', derived: undefined, persist: undefined };
    return { scope: undefined, derived: undefined };
}

export function VariableBehaviour({ variable, onChange, disabled = false }: VariableBehaviourProps) {
    const { t } = useTranslation();
    const kind = kindOf(variable);
    const expr = kind === 'derived' ? String((variable.derived as { expr: string }).expr) : '';
    const hint = kind === 'screen'
        ? t('studio_apps_variables.editor.kind_hint_screen', 'Starts from its starting value again each time a screen opens.')
        : kind === 'derived'
            ? t('studio_apps_variables.editor.kind_hint_derived', 'Worked out again whenever what the formula reads changes. A step that writes it changes nothing; while the formula gives nothing, the starting value shows.')
            : undefined;
    return (
        <div className="flex flex-col gap-2" data-variable-behaviour={variable.name}>
            <div className="grid grid-cols-2 gap-2">
                <FormField label={t('studio_apps_variables.editor.kind', 'Value')} hint={hint}>
                    <select
                        className={INPUT_CLS}
                        value={kind}
                        onChange={(e) => onChange(changesForKind(e.target.value as Kind))}
                        disabled={disabled}
                        aria-label={t('studio_apps_variables.editor.kind_aria', 'Kind of {name}', { name: variable.name })}
                    >
                        <option value="app">{t('studio_apps_variables.editor.kind_app', 'Set by the app')}</option>
                        <option value="screen">{t('studio_apps_variables.editor.kind_screen', 'Set by the app, per screen')}</option>
                        <option value="derived">{t('studio_apps_variables.editor.kind_derived', 'Worked out from a formula')}</option>
                    </select>
                </FormField>
                {kind === 'app' ? (
                    <FormField
                        label={t('studio_apps_variables.editor.persist', 'Remember after a reload')}
                        hint={t('studio_apps_variables.editor.persist_hint', 'Only for signed-in people, in their own browser. Never keep personal data or anything secret here.')}
                    >
                        <select
                            className={INPUT_CLS}
                            value={persistOf(variable)}
                            onChange={(e) => onChange({ persist: e.target.value === 'none' ? undefined : e.target.value })}
                            disabled={disabled}
                            aria-label={t('studio_apps_variables.editor.persist_aria', 'Remember {name} after a reload', { name: variable.name })}
                        >
                            <option value="none">{t('studio_apps_variables.editor.persist_none', 'No')}</option>
                            <option value="session">{t('studio_apps_variables.editor.persist_session', 'Until the browser tab closes')}</option>
                            <option value="local">{t('studio_apps_variables.editor.persist_local', 'On this device')}</option>
                        </select>
                    </FormField>
                ) : null}
            </div>
            {kind === 'derived' ? (
                <FormField label={t('studio_apps_variables.editor.formula', 'Formula')}>
                    <input
                        key={expr}
                        type="text"
                        className={`${INPUT_CLS} font-mono`}
                        defaultValue={expr}
                        onBlur={(e) => {
                            const next = e.target.value.trim();
                            if (next && next !== expr) onChange({ derived: { expr: next } });
                        }}
                        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                        placeholder={t('studio_apps_variables.editor.formula_example', 'vars.price * vars.quantity')}
                        spellCheck={false}
                        disabled={disabled}
                        aria-label={t('studio_apps_variables.editor.formula_aria', 'Formula of {name}', { name: variable.name })}
                    />
                </FormField>
            ) : null}
        </div>
    );
}
