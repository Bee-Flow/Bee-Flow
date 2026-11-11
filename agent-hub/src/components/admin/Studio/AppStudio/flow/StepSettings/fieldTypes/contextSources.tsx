import { X } from 'lucide-react';
import { useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import FormField from '@/components/shared/FormField';
import IconButton from '@/components/shared/IconButton';
import BindingField from '@/components/admin/Studio/AppStudio/inspector/panels/BindingField';
import { INPUT_CLS } from '@/components/admin/Studio/AppStudio/inspector/panels/kit';
import type { StepFieldControlProps, StepFieldTypeModule } from '../fieldTypes';

/** LIMITS.MAX_CONTEXT_SOURCES and LIMITS.MAX_CONTEXT_SOURCE_LABEL. */
const MAX_SOURCES = 12;
const MAX_LABEL = 120;

/** A source is a binding, whatever object the binding chooser hands back. */
type Source = object;

interface ContextSource { label?: string; source: Source }

const isSource = (v: unknown): v is ContextSource => !!v && typeof v === 'object' && !!(v as ContextSource).source && typeof (v as ContextSource).source === 'object';

/** An entry as canonicalize keeps it: the label only when it says something. */
function entryOf(label: string | undefined, source: Source): ContextSource {
    return typeof label === 'string' && label.trim() ? { label, source } : { source };
}

/**
 * `contextSources`: extra labelled data an AI step reads next to its prompt (the conversation AND
 * the order lines, each named, so the model is not handed two anonymous arrays). Each source is
 * picked with the same binding chooser the step's promptContext uses.
 *
 * An entry is only written once it has a source: canonicalize drops a label with nothing under
 * it, so a new row waits here until its source is chosen.
 */
function ContextSourcesControl({ value, onChange, definition, node, disabled }: StepFieldControlProps) {
    const { t } = useTranslation();
    const entries = (Array.isArray(value) ? value : []).filter(isSource);
    const [pending, setPending] = useState<string | null>(null);
    const commit = (next: ContextSource[]) => onChange(next.length ? next : undefined);
    const update = (i: number, patch: Partial<ContextSource>) => {
        const cur = entries[i];
        commit(entries.map((e, j) => (j === i ? entryOf(patch.label ?? cur.label, patch.source ?? cur.source) : e)));
    };
    const room = entries.length + (pending === null ? 0 : 1) < MAX_SOURCES;
    return (
        <FormField
            label={t('studio_apps_step_fields.context.label', 'More context')}
            hint={t('studio_apps_step_fields.context.hint', 'Extra data the AI reads with the prompt, each under its own name, for example the conversation and the order lines. At most {max}.', { max: MAX_SOURCES })}
        >
            <div className="flex flex-col gap-2" data-step-control="contextSources">
                {entries.map((e, i) => (
                    <SourceRow
                        key={i}
                        index={i}
                        label={e.label ?? ''}
                        source={e.source}
                        onLabel={(label) => update(i, { label })}
                        onSource={(source) => update(i, { source })}
                        onRemove={() => commit(entries.filter((_, j) => j !== i))}
                        definition={definition}
                        node={node}
                        disabled={disabled}
                    />
                ))}
                {pending !== null ? (
                    <SourceRow
                        index={entries.length}
                        label={pending}
                        source={undefined}
                        onLabel={setPending}
                        onSource={(source) => { commit([...entries, entryOf(pending, source)]); setPending(null); }}
                        onRemove={() => setPending(null)}
                        definition={definition}
                        node={node}
                        disabled={disabled}
                    />
                ) : null}
                {room ? (
                    <button
                        type="button"
                        onClick={() => setPending('')}
                        disabled={disabled || pending !== null}
                        className="self-start rounded border border-dashed border-[var(--border-default)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-50"
                    >
                        {t('studio_apps_step_fields.context.add', 'Add a source')}
                    </button>
                ) : null}
            </div>
        </FormField>
    );
}

interface SourceRowProps {
    index: number;
    label: string;
    source: Source | undefined;
    onLabel: (label: string) => void;
    onSource: (source: Source) => void;
    onRemove: () => void;
    definition: StepFieldControlProps['definition'];
    node: StepFieldControlProps['node'];
    disabled: boolean;
}

function SourceRow({ index, label, source, onLabel, onSource, onRemove, definition, node, disabled }: SourceRowProps) {
    const { t } = useTranslation();
    const n = index + 1;
    return (
        <div className="flex flex-col gap-1.5 rounded-md border border-[var(--border-subtle)] p-2">
            <div className="flex items-center gap-1.5">
                <input
                    type="text"
                    className={INPUT_CLS}
                    value={label}
                    maxLength={MAX_LABEL}
                    onChange={(e) => onLabel(e.target.value)}
                    placeholder={t('studio_apps_step_fields.context.label_placeholder', 'Name, e.g. Order lines')}
                    disabled={disabled}
                    aria-label={t('studio_apps_step_fields.context.label_aria', 'Name of source {n}', { n })}
                />
                <IconButton ariaLabel={t('studio_apps_step_fields.context.remove', 'Remove source {n}', { n })} onClick={onRemove} disabled={disabled} variant="danger" size="sm">
                    <X />
                </IconButton>
            </div>
            <BindingField
                label={t('studio_apps_step_fields.context.source', 'Source {n}', { n })}
                value={source}
                onChange={(b) => onSource(b)}
                definition={definition}
                node={node}
                disabled={disabled}
            />
        </div>
    );
}

const entry: StepFieldTypeModule = { type: 'contextSources', Control: ContextSourcesControl };
export default entry;
