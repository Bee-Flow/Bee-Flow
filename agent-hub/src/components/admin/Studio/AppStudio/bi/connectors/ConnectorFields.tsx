/**
 * The small form pieces of the connectors editor: a text field, a JSON object
 * field, the viewer-params list, the kind question and the automation field.
 */
import { AppWindow, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import { INPUT, LABEL, PARAM_TYPES, kinds } from './connectorModel';
import type { Connector, ConnectorParam } from './connectorModel';
import useAutomationApi from '../../../../../../hooks/useAutomationApi';
import useTranslation from '../../../../../../hooks/useTranslation';
import ChoiceCards from '../../../../../shared/ChoiceCards';
import Disclosure from '../../../../../shared/Disclosure';
import AutomationPickerJs from '../../inspector/AutomationPicker';

// AutomationPicker.jsx defaults `appRef` to null and `formFields` to [].
const AutomationPicker = AutomationPickerJs as unknown as ComponentType<{
    open: boolean;
    onClose: () => void;
    onPick: (automation: { id?: string; title?: string } | null) => void;
}>;

interface TextFieldProps {
    label: string;
    value: string | undefined;
    onChange: (value: string) => void;
    disabled?: boolean;
    placeholder?: string;
}

export function TextField({ label, value, onChange, disabled, placeholder }: TextFieldProps) {
    return (
        <label className="flex flex-col gap-1">
            <span className={LABEL}>{label}</span>
            <input
                className={INPUT}
                value={value ?? ''}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                disabled={disabled}
                spellCheck={false}
            />
        </label>
    );
}

interface JsonObjectFieldProps {
    label: string;
    value: Record<string, unknown> | undefined;
    onChange: (value: Record<string, unknown> | undefined) => void;
    disabled?: boolean;
    placeholder?: string;
}

// A JSON object editor that keeps its own raw text and only commits VALID JSON
// objects upward — an invalid draft shows an inline hint without corrupting the
// model (parity with how the data model tolerates half-typed input).
export function JsonObjectField({ label, value, onChange, disabled, placeholder }: JsonObjectFieldProps) {
    const { t } = useTranslation();
    const [text, setText] = useState(() => (value && Object.keys(value).length ? JSON.stringify(value, null, 2) : ''));
    const [error, setError] = useState<string | null>(null);
    const commit = (raw: string) => {
        setText(raw);
        const trimmed = raw.trim();
        if (trimmed === '') { setError(null); onChange(undefined); return; }
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { setError(t('studio_apps_bi.connectors.json_must_be_object', 'Must be a JSON object')); return; }
            setError(null);
            onChange(parsed);
        } catch {
            setError(t('studio_apps_bi.params.invalid_json', 'Invalid JSON'));
        }
    };
    return (
        <label className="flex flex-col gap-1">
            <span className={LABEL}>{label}</span>
            <textarea
                className={`${INPUT} font-mono min-h-[4.5rem]`}
                value={text}
                onChange={(e) => commit(e.target.value)}
                placeholder={placeholder}
                disabled={disabled}
                spellCheck={false}
            />
            {error ? <span className="text-xs text-[var(--error)]">{error}</span> : null}
        </label>
    );
}

interface ParamRowProps {
    p: ConnectorParam;
    i: number;
    patch: (i: number, p: Partial<ConnectorParam>) => void;
    remove: (i: number) => void;
    disabled?: boolean;
}

function ParamRow({ p, i, patch, remove, disabled }: ParamRowProps) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-1.5">
            <input
                className={`${INPUT} flex-1`}
                value={p.key || ''}
                onChange={(e) => patch(i, { key: e.target.value })}
                placeholder={t('studio_apps_bi.connectors.param_key_placeholder', 'key')}
                disabled={disabled}
                aria-label={t('studio_apps_bi.connectors.param_key', 'Param {n} key', { n: i + 1 })}
                spellCheck={false}
            />
            <select
                className={`${INPUT} w-28`}
                value={p.type || 'text'}
                onChange={(e) => patch(i, { type: e.target.value })}
                disabled={disabled}
                aria-label={t('studio_apps_bi.connectors.param_type', 'Param {n} type', { n: i + 1 })}
            >
                {PARAM_TYPES.map((pt) => <option key={pt} value={pt}>{pt}</option>)}
            </select>
            <label className="inline-flex items-center gap-1 text-xs text-[var(--text-secondary)]">
                <input
                    type="checkbox"
                    checked={!!p.required}
                    onChange={(e) => patch(i, { required: e.target.checked })}
                    disabled={disabled}
                    className="accent-[var(--accent-primary)]"
                />
                {t('studio_apps_bi.connectors.param_req', 'req')}
            </label>
            <button
                type="button"
                onClick={() => remove(i)}
                disabled={disabled}
                aria-label={t('studio_apps_bi.connectors.remove_param', 'Remove param {n}', { n: i + 1 })}
                className="p-1 rounded hover:bg-[var(--bg-card-hover)] text-[var(--error)]"
            >
                <Trash2 className="h-3.5 w-3.5" />
            </button>
        </div>
    );
}

export function ParamsEditor({ params, onChange, disabled }: { params: ConnectorParam[] | undefined; onChange: (params: ConnectorParam[]) => void; disabled?: boolean }) {
    const { t } = useTranslation();
    const list = Array.isArray(params) ? params : [];
    const patch = (i: number, p: Partial<ConnectorParam>) => onChange(list.map((x, j) => (j === i ? { ...x, ...p } : x)));
    const add = () => onChange([...list, { key: '', type: 'text', required: false }]);
    const remove = (i: number) => onChange(list.filter((_, j) => j !== i));
    return (
        <div className="flex flex-col gap-1.5">
            <span className={LABEL}>{t('studio_apps_bi.connectors.viewer_params', 'Viewer params')}</span>
            {list.length === 0 ? (
                <p className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_bi.connectors.no_params', 'No params — the connector runs with only its pinned arguments.')}</p>
            ) : null}
            {list.map((p, i) => <ParamRow key={i} p={p} i={i} patch={patch} remove={remove} disabled={disabled} />)}
            <button
                type="button"
                onClick={add}
                disabled={disabled}
                className="self-start inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs border-[var(--border-default)] text-[var(--text-secondary)]"
            >
                <Plus className="h-3 w-3" aria-hidden="true" /> {t('studio_apps_bi.connectors.add_param', 'Add param')}
            </button>
        </div>
    );
}

interface KindChooserProps {
    onCreate: (kind: string) => void;
    onCancel: (() => void) | null;
    onPickApps?: () => void;
    disabled?: boolean;
}

/**
 * The kind question, asked before anything is created.
 *
 * "An app you already use" no longer creates an empty connector to configure —
 * it opens the picker, where ticking actions creates one connector each. The
 * other two kinds still create a single blank connector, because an automation or a
 * URL is genuinely one thing you then fill in.
 */
export function KindChooser({ onCreate, onCancel, onPickApps, disabled }: KindChooserProps) {
    const { t } = useTranslation();
    const [kind, setKind] = useState('integration_tool');
    const pickingApps = kind === 'integration_tool';
    return (
        <div className="flex flex-col gap-3">
            <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">{t('studio_apps_bi.connectors.where_data', 'Where should this get its data?')}</p>
                <p className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_bi.connectors.change_later', 'You can change this later.')}</p>
            </div>
            <ChoiceCards
                value={kind}
                onChange={setKind}
                options={kinds(t)}
                columns={1}
                ariaLabel={t('studio_apps_bi.connectors.where_data', 'Where should this get its data?')}
                disabled={disabled}
            />
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={() => (pickingApps ? onPickApps?.() : onCreate(kind))}
                    disabled={disabled}
                    className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 bg-[var(--accent-primary)]"
                >
                    {pickingApps ? <AppWindow className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                    {pickingApps ? t('studio_apps_bi.connectors.choose_apps', 'Choose apps & actions') : t('studio_apps_bi.connectors.add_it', 'Add it')}
                </button>
                {onCancel ? (
                    <button type="button" onClick={onCancel} className="rounded-md px-3 py-1.5 text-sm text-[var(--text-secondary)]">
                        {t('studio_apps_bi.common.cancel', 'Cancel')}
                    </button>
                ) : null}
            </div>
        </div>
    );
}

/**
 * The automation a connector runs, by name. The picker is the same one the
 * inspector uses; the id stays hand-editable one disclosure deeper for automations
 * the list can't reach (another owner's, or one built after this loaded).
 */
export function AutomationField({ connector, onChangeId, disabled }: { connector: Connector; onChangeId: (id: string) => void; disabled?: boolean }) {
    const { t } = useTranslation();
    const api = useAutomationApi();
    const [open, setOpen] = useState(false);
    const [titles, setTitles] = useState<Record<string, string>>({});
    const automationId = connector.automationId || '';
    const title = automationId ? titles[automationId] || null : null;

    useEffect(() => {
        if (!automationId) return undefined;
        let alive = true;
        api.listAutomations()
            .then((raw: unknown) => {
                const r = raw as { automations?: Array<{ id: string; title?: string }> };
                const found = (r.automations || []).find((a) => a.id === automationId)?.title || '';
                if (alive) setTitles((prev) => ({ ...prev, [automationId]: found }));
            })
            .catch(() => { /* the id stays on screen — it is still the truth */ });
        return () => { alive = false; };
    }, [automationId, api]);

    return (
        <div className="flex flex-col gap-1.5">
            <span className={LABEL}>{t('studio_apps_bi.connectors.kind_automation_tag', 'Automation')}</span>
            <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm" style={{ color: automationId ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
                    {title || automationId || t('studio_apps_bi.connectors.no_automation', 'No automation chosen yet')}
                </span>
                <button
                    type="button"
                    onClick={() => setOpen(true)}
                    disabled={disabled}
                    className="shrink-0 rounded-md border px-2.5 py-1.5 text-xs font-medium disabled:opacity-50 border-[var(--border-default)] text-[var(--text-primary)]"
                >
                    {automationId ? t('studio_apps_bi.connectors.choose_another', 'Choose another') : t('studio_apps_bi.connectors.choose_automation', 'Choose an automation')}
                </button>
            </div>
            <Disclosure title={t('studio_apps_bi.connectors.type_id', 'Type the id myself')}>
                <TextField
                    label={t('studio_apps_bi.connectors.automation_id', 'Automation id')}
                    value={connector.automationId}
                    onChange={onChangeId}
                    disabled={disabled}
                    placeholder="auto-123"
                />
            </Disclosure>
            <AutomationPicker
                open={open}
                onClose={() => setOpen(false)}
                onPick={(automation) => {
                    setOpen(false);
                    if (automation?.id) setTitles((prev) => ({ ...prev, [automation.id as string]: automation.title || '' }));
                    onChangeId(automation?.id || '');
                }}
            />
        </div>
    );
}
