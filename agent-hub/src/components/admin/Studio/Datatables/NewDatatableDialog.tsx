import { ChevronDown, Cloud, FileSpreadsheet, Plus, X } from 'lucide-react';
import React, { useState } from 'react';
import AiTablePanel from './AiTablePanel';
import { ColumnKindIcon, kindWord } from './ColumnKind';
import { COLUMN_TYPES, SOURCE_KINDS, canLinkNextcloud, columnTypeKind, keyFromName, validateColumns } from './datatableDisplay';
import LinkNextcloudTablesDialog from './LinkNextcloudTablesDialog';
import LinkSpreadsheetDialog from './LinkSpreadsheetDialog';
import AudienceChoice from './newDatatable/AudienceChoice';
import { INPUT, INPUT_STYLE } from './newDatatable/constants';
import CreatedResultModal from './newDatatable/CreatedResultModal';
import KindChoice from './newDatatable/KindChoice';
import LinkedResultModal from './newDatatable/LinkedResultModal';
import NewDatatableFooter from './newDatatable/NewDatatableFooter';
import NewTableFields from './newDatatable/NewTableFields';
import { useLinkSources } from './newDatatable/useLinkSources';
import useTranslation from '@/hooks/useTranslation';
import { kindIcon, kindTileStyle } from '@/components/shared/kindColors';
import Modal from '@/components/shared/Modal';
import SegmentedControl from '@/components/shared/SegmentedControl';
import type { TableColumn } from '../AppStudio/inspector/aiFieldMatching';
import { type NewDatatableDialogProps, type LinkedBody, type LinkedResult, type CreatedResult, type TitleRowProps, type FirstColumnsProps, type TypeSelectProps } from './NewDatatableDialog.types';
import { orgScopeChoice, submitDraft, applyDraft } from './NewDatatableDialog.helpers';

export default function NewDatatableDialog({ scope = null, onClose, onCreated, user = null }: NewDatatableDialogProps) {
    const { t } = useTranslation();
    const [kind, setKind] = useState('plain');
    const [mode, setMode] = useState('simple');   // simple | advanced
    const [name, setName] = useState('');
    const [key, setKey] = useState('');
    const [keyTouched, setKeyTouched] = useState(false);
    const [description, setDescription] = useState('');
    const [fields, setFields] = useState<TableColumn[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // A managed table's answer carries the sentence about what its rows hold.
    // The dialog stays open on it: it is the one real reduction against the
    // hidden cache tier, and closing over it would make it a notification.
    const [created, setCreated] = useState<CreatedResult | null>(null);
    const { canChoose, orgScopeWithheld } = orgScopeChoice(scope, user);
    const [target, setTarget] = useState(canChoose ? 'organisation' : 'personal');

    const managed = kind === 'http_cache';
    const nextcloud = kind === 'nextcloud_table';
    const spreadsheet = kind === 'spreadsheet_file';
    // Either mirror kind: the table is named per table in the next step.
    const linking = nextcloud || spreadsheet;
    // A Nextcloud-bound organisation? Then ask the server what this account
    // could link — once, on open — so the card can say why it is off.
    const offerNextcloud = canLinkNextcloud(user);
    const [picking, setPicking] = useState<string | null>(null);     // null | 'nextcloud' | 'spreadsheet'
    const [linked, setLinked] = useState<LinkedResult | null>(null);       // a wizard's answer, tagged with its kind
    const { linkable, providers } = useLinkSources(offerNextcloud, canChoose);
    const offerSpreadsheet = !!(providers && providers.length);
    const ssConnected = !!(providers && providers.some(p => p.connected));

    const effectiveKey = keyTouched ? key : keyFromName(name);
    const columnProblems = validateColumns(fields);
    // A managed table's description is optional here ONLY because the server
    // fills in its own sentence; on an ordinary table an empty one is a 400.
    // A mirror is named per table in the next step.
    const ready = nextcloud
        ? !!(linkable && linkable.connected)
        : spreadsheet
            ? ssConnected
            : (!!name.trim() && !!effectiveKey && (managed || !!description.trim()) && columnProblems.length === 0);

    const submit = (e: React.SyntheticEvent<Element, Event> | React.SubmitEvent<HTMLFormElement>) => submitDraft(e, {
        nextcloud, spreadsheet, managed, target, name, effectiveKey, description, fields, t, onCreated,
        setPicking, setBusy, setError, setCreated,
    });

    if (picking === 'nextcloud') {
        return (
            <LinkNextcloudTablesDialog
                scope={target}
                linkable={linkable}
                onBack={() => setPicking(null)}
                onClose={onClose}
                onLinked={(body: unknown) => { setPicking(null); setLinked({ ...(body as LinkedBody), kind: 'nextcloud_table' }); }}
            />
        );
    }

    if (picking === 'spreadsheet') {
        return (
            <LinkSpreadsheetDialog
                scope={target}
                providers={providers || []}
                onBack={() => setPicking(null)}
                onClose={onClose}
                onLinked={(body: unknown) => { setPicking(null); setLinked({ ...(body as LinkedBody), kind: 'spreadsheet_file' }); }}
            />
        );
    }

    if (linked) {
        const n = (linked.datatables || []).length;
        // The kind's own sentence about what happens next (the registry's
        // `linkedBody`); the title has no source in it and is shared.
        const spec = SOURCE_KINDS[linked.kind] || SOURCE_KINDS.nextcloud_table;
        return (
            <LinkedResultModal
                title={<TitleRow kind="datatable" icon={spec.icon === 'spreadsheet' ? FileSpreadsheet : Cloud} text={t('datatables.nc_linked_title', 'The tables are ready')} />}
                body={spec.linkedBody(t, n)}
                warnings={linked.warnings || []}
                onOpen={() => onCreated(linked.datatables[0])}
                t={t}
            />
        );
    }

    if (created) {
        return (
            <CreatedResultModal
                title={<TitleRow kind="datatable" text={t('datatables.created_title', 'The table is ready')} />}
                warning={created.warning}
                onOpen={() => onCreated(created.datatable)}
                t={t}
            />
        );
    }

    return (
        <Modal
            open
            onClose={onClose}
            size="md"
            className="sm:max-w-[520px]"
            title={<TitleRow kind={managed ? 'app' : 'datatable'} icon={nextcloud ? Cloud : spreadsheet ? FileSpreadsheet : null} text={t('datatables.new_title', 'New datatable')} />}
            headerActions={linking ? null : (
                <SegmentedControl
                    size="sm"
                    ariaLabel={t('datatables.detail_level', 'How much to show')}
                    value={mode}
                    onChange={setMode}
                    options={[
                        { value: 'simple', label: t('datatables.simple', 'Simple') },
                        { value: 'advanced', label: t('datatables.all_options', 'All options') },
                    ]}
                />
            )}
            footer={(
                <NewDatatableFooter
                    nextcloud={nextcloud}
                    spreadsheet={spreadsheet}
                    effectiveKey={effectiveKey}
                    mode={mode}
                    onClose={onClose}
                    submit={submit}
                    busy={busy}
                    ready={ready}
                    t={t}
                />
            )}
        >
            <form onSubmit={submit} className="space-y-4">
                <KindChoice
                    kind={kind}
                    setKind={setKind}
                    managed={managed}
                    nextcloud={nextcloud}
                    spreadsheet={spreadsheet}
                    offerNextcloud={offerNextcloud}
                    offerSpreadsheet={offerSpreadsheet}
                    linkable={linkable}
                    ssConnected={ssConnected}
                    providers={providers || []}
                    t={t}
                />

                {kind === 'plain' && (
                    <AiTablePanel
                        mode="create"
                        compact
                        current={{ name, description, fields }}
                        onApply={(d) => applyDraft(d, { setName, setDescription, setFields, setKeyTouched })}
                        testId="new-table-ai"
                    />
                )}

                <NewTableFields
                    linking={linking}
                    managed={managed}
                    mode={mode}
                    name={name}
                    setName={setName}
                    effectiveKey={effectiveKey}
                    setKey={setKey}
                    setKeyTouched={setKeyTouched}
                    description={description}
                    setDescription={setDescription}
                    firstColumns={<FirstColumns t={t} fields={fields} problems={columnProblems} onChange={setFields} />}
                    t={t}
                />

                <AudienceChoice canChoose={canChoose} orgScopeWithheld={orgScopeWithheld} target={target} setTarget={setTarget} t={t} />

                {error && (
                    <p role="alert" className="text-xs px-3 py-2 rounded-lg bg-[var(--bg-primary)] text-[var(--warning)]">
                        {error}
                    </p>
                )}
            </form>
        </Modal>
    );
}

export function TitleRow({ kind, text, icon = null }: TitleRowProps) {
    const { tile, glyph } = kindTileStyle(kind, { size: 28, pct: 18 });
    // `icon` overrides the kind's glyph (a Nextcloud table wears the cloud).
    // createElement rather than a `Glyph` variable: a component assigned in
    // render trips react-hooks/static-components, and this is not one.
    const glyphType = icon || kindIcon(kind);
    return (
        <span className="flex items-center gap-2.5">
            <span style={tile} aria-hidden="true">{glyphType ? React.createElement(glyphType, { style: glyph }) : null}</span>
            <span className="text-[14px] font-semibold">{text}</span>
        </span>
    );
}

function FirstColumns({ t, fields, problems, onChange }: FirstColumnsProps) {
    const set = (i: number, patch: Partial<TableColumn>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
    return (
        <div className="space-y-2">
            <div className="flex items-baseline gap-2">
                <span className="text-sm font-medium text-[var(--text-primary)]">
                    {t('datatables.first_columns', 'Columns')}
                </span>
                <span className="text-[11px] text-[var(--text-tertiary)]">
                    {t('datatables.first_columns_hint', 'optional · can also be added later')}
                </span>
            </div>
            {fields.map((f, i) => (
                <div key={i} className="grid gap-2 items-center [grid-template-columns:minmax(0,1fr)_160px_28px]">
                    <input
                        value={f.name}
                        onChange={(e) => set(i, { name: e.target.value, key: keyFromName(e.target.value) })}
                        placeholder={t('datatables.column_name', 'Column name')}
                        aria-label={t('datatables.column_name', 'Column name')}
                        className={INPUT}
                        style={INPUT_STYLE}
                    />
                    <TypeSelect t={t} value={f.type} onChange={(type) => set(i, { type })} />
                    <button type="button" onClick={() => onChange(fields.filter((_, j) => j !== i))}
                        aria-label={t('datatables.column_remove', 'Remove this column')}
                        className="p-1 rounded justify-self-center focus-visible:outline focus-visible:outline-2 [color:var(--text-tertiary)] [outline-color:var(--accent-primary)]!">
                        <X className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                </div>
            ))}
            <button
                type="button"
                onClick={() => onChange([...fields, { key: '', name: '', type: 'text' }])}
                className="text-xs inline-flex items-center gap-1.5 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 [color:var(--text-secondary)]! [outline-color:var(--accent-primary)]!"
            >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {t('datatables.column_add', 'Add a column')}
            </button>
            {problems.length > 0 && (
                <ul role="alert" className="text-xs space-y-1 px-3 py-2 rounded-lg bg-[var(--bg-primary)] text-[var(--warning)]">
                    {problems.map((p, i) => <li key={i}>{p}</li>)}
                </ul>
            )}
        </div>
    );
}

export function TypeSelect({ t, value, onChange, disabled = false, ariaLabel, types = COLUMN_TYPES }: TypeSelectProps) {
    const kind = columnTypeKind(value);
    return (
        <span className="relative block min-w-0">
            <span
                className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs border pointer-events-none"
                style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)', opacity: disabled ? 0.6 : 1 }}
                aria-hidden="true"
            >
                <ColumnKindIcon kind={kind} size={14} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                <span className="truncate">{kindWord(t, kind)}</span>
                <ChevronDown className="w-3 h-3 ml-auto shrink-0 text-[var(--text-tertiary)]" />
            </span>
            <select
                value={value || 'text'}
                disabled={disabled}
                aria-label={ariaLabel || t('datatables.column_type', 'Column type')}
                onChange={(e) => onChange(e.target.value)}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-default"
            >
                {types.map(ct => <option key={ct.type} value={ct.type}>{t(`studio_misc.coltype.${ct.type}`, ct.label)}</option>)}
            </select>
        </span>
    );
}

