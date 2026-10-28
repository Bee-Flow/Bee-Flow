import { INPUT_CLS } from '../kit';
import useTranslation from '@/hooks/useTranslation';
import useConnectors from '@/components/admin/Studio/AppStudio/bi/useConnectors';
import FormulaField from '../../logic/FormulaField';
import type { ConnectorParamFieldProps, ConnectorBindingProps } from '../BindingField.types';
import { staticDisplay, parseStatic, isFormulaVal } from './BindingField.helpers';

// One declared param: a literal (Value) OR a {kind:'formula',expr} toggle.
function ConnectorParamField({ param, value, onChange, definition, node, disabled }: ConnectorParamFieldProps) {
    const { t } = useTranslation();
    const isFormula = isFormulaVal(value);
    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--text-secondary)]">{param.key}{param.required ? ' *' : ''}</span>
                <label className="inline-flex items-center gap-1 text-[11px] text-[var(--text-secondary)]">
                    <input
                        type="checkbox"
                        checked={isFormula}
                        onChange={(e) => onChange(e.target.checked ? { kind: 'formula', expr: '' } : undefined)}
                        disabled={disabled}
                        className="accent-[var(--accent-primary)]"
                    />
                    {t('studio_apps_panels.binding.formula', 'formula')}
                </label>
            </div>
            {isFormula ? (
                <FormulaField
                    value={String((value as { expr?: unknown }).expr || '')}
                    onChange={(expr) => onChange({ kind: 'formula', expr })}
                    definition={definition}
                    node={node}
                    placeholder={t('studio_apps_panels.binding.param_formula_placeholder', 'e.g. vars.filters.q')}
                    disabled={disabled}
                />
            ) : (
                <input
                    type="text"
                    className={INPUT_CLS}
                    value={value == null ? '' : (typeof value === 'string' ? value : staticDisplay(value))}
                    onChange={(e) => onChange(e.target.value === '' ? undefined : parseStatic(e.target.value))}
                    placeholder={param.type || 'text'}
                    disabled={disabled}
                    spellCheck={false}
                    aria-label={t('studio_apps_panels.binding.param_aria', 'Param {key}', { key: param.key })}
                />
            )}
        </div>
    );
}

export function ConnectorBinding({ binding, onChange, appId, definition, node, disabled }: ConnectorBindingProps) {
    const { t } = useTranslation();
    const { connectors, isLoading } = useConnectors(appId);

    if (!appId) {
        return <p className="text-xs text-[var(--text-secondary)]">{t('studio_apps_panels.binding.open_app_use_system', 'Open the app to use another system.')}</p>;
    }

    const connectorId = binding.connectorId || '';
    const selected = connectors.find((c) => c.id === connectorId) || null;
    const declaredParams = selected && Array.isArray(selected.params) ? selected.params : [];
    const params = binding.params && typeof binding.params === 'object' && !Array.isArray(binding.params) ? binding.params : {};

    const setParam = (key: string, val: unknown) => {
        const next = { ...params };
        if (val === undefined) delete next[key]; else next[key] = val;
        onChange({ kind: 'connector', connectorId, params: next });
    };

    return (
        <div className="flex flex-col gap-2">
            <select
                className={INPUT_CLS}
                value={connectorId}
                onChange={(e) => onChange({ kind: 'connector', connectorId: e.target.value || null, params: {} })}
                disabled={disabled}
                aria-label={t('studio_apps_panels.binding.connector', 'Connector')}
            >
                <option value="">{isLoading ? t('studio_apps_panels.binding.loading_connectors', 'Loading connectors…') : t('studio_apps_panels.binding.pick_connector', 'Pick a connector…')}</option>
                {connectors.map((c) => <option key={c.id} value={c.id}>{c.name || c.id}</option>)}
            </select>

            {connectorId && declaredParams.length ? (
                <div className="flex flex-col gap-2">
                    {declaredParams.map((p) => (
                        <ConnectorParamField
                            key={p.key}
                            param={p}
                            value={params[p.key]}
                            onChange={(v) => setParam(p.key, v)}
                            definition={definition}
                            node={node}
                            disabled={disabled}
                        />
                    ))}
                </div>
            ) : null}
            {connectorId && !declaredParams.length ? (
                <p className="text-xs text-[var(--text-secondary)]">{t('studio_apps_panels.binding.no_params', 'This connector takes no params.')}</p>
            ) : null}
            {connectors.length === 0 && !isLoading ? (
                <p className="text-xs text-[var(--text-secondary)]">{t('studio_apps_panels.binding.no_connectors', 'No connectors yet — add one in the Tables → Connectors tab.')}</p>
            ) : null}
        </div>
    );
}
