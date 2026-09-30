/**
 * One renderer per field kind: the spec's field → the field kit's control
 * (components/fields) or one of the rows beside this file. Each gets the
 * field's value and a setter already wired through the spec's read/write, so
 * none of them knows about keys, drafts or saving.
 */

import React, { type ReactElement } from 'react';

import type { TranslateFn } from '@/core/i18n';
import { autoMapInputs, type ForEach } from '@/features/flow-editor/bindings';
import {
    BindingInput,
    ChipsField,
    ChoiceField,
    DurationField,
    JsonSchemaForm,
    MultilineField,
    NumberField,
    RowsEditor,
    SelectField,
    StringListField,
    ToggleField,
} from '@/features/flow-editor/components/fields';
import type { FormDraft } from '@/features/flow-editor/formState';
import type { Inputs } from '@/features/flow-editor/schemaForm';
import { Banner, InfoRow, Segmented, Text } from '@/shared/ui';

import { AskOnceRow, askOnceBlocked } from './rows/AskOnceRow';
import { ContractInputs } from './rows/ContractInputs';
import { ExtractionRows } from './rows/ExtractionRows';
import { ForEachRow } from './rows/ForEachRow';
import { RetryRow } from './rows/RetryRow';
import { SuggestText } from './rows/SuggestText';
import { TemplateMap } from './rows/TemplateMap';
import { resolveOptions, resolveWords, say } from './runtime';
import type { FieldKind, FieldSpec, SpecContext } from './spec';
import { findActionAndSiblings } from './specs/integration';

export interface RenderProps {
    field: FieldSpec;
    value: unknown;
    set: (value: unknown) => void;
    draft: FormDraft;
    ctx: SpecContext;
    t: TranslateFn;
    label?: string;
    hint: string | null;
    prompt?: string;
    required?: boolean;
    disabled: boolean;
}

type Renderer = (p: RenderProps) => ReactElement | null;

const text = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

function options(p: RenderProps) {
    if (!('options' in p.field)) return [];
    return resolveOptions(p.field.options, p.draft, p.ctx).map((o) => ({
        value: o.value,
        label: say(p.t, o.label),
        description: o.blurb ? say(p.t, o.blurb) : undefined,
        disabled: o.disabled,
        fixed: o.fixed,
    }));
}

const common = (p: RenderProps) => ({ label: p.label, hint: p.hint, required: p.required, disabled: p.disabled });

const renderTemplate: Renderer = (p) => (
    <BindingInput mode="template" {...common(p)} value={text(p.value)} onChange={p.set} prompt={p.prompt} multiline={p.field.kind === 'template' && p.field.multiline} />
);

const renderSegmented: Renderer = (p) => (
    <SelectOrSegmented {...p} />
);

function SelectOrSegmented(p: RenderProps) {
    const opts = options(p);
    return (
        <>
            {p.label ? <Text variant="caption" tone="secondary" weight="medium">{p.label}</Text> : null}
            <Segmented value={text(p.value)} onChange={p.set} options={opts} accessibilityLabel={p.label} fullWidth />
            {p.hint ? <Text variant="caption" tone="tertiary">{p.hint}</Text> : null}
        </>
    );
}

function renderSchema(p: RenderProps): ReactElement | null {
    if (p.field.kind !== 'schema') return null;
    const schema = p.field.schema(p.draft, p.ctx);
    const inputs = (p.value || {}) as Inputs;
    const autoMap = () => {
        const patch = autoMapInputs(schema, inputs, [...p.ctx.groups]);
        if (Object.keys(patch).length) p.set({ ...inputs, ...patch });
    };
    return (
        <>
            {p.hint ? <Text variant="caption" tone="tertiary">{p.hint}</Text> : null}
            <JsonSchemaForm
                inputSchema={schema}
                inputs={inputs}
                onChange={p.set}
                autoMappedKeys={(p.ctx.step.autoMapped as string[] | undefined) ?? []}
                onAutoMap={p.ctx.groups.length ? autoMap : undefined}
                allowExtra={schema ? schema.additionalProperties === true : true}
                disabled={p.disabled}
            />
        </>
    );
}

function renderAskOnce(p: RenderProps): ReactElement {
    const found = findActionAndSiblings(p.ctx.catalog, p.draft.tool || p.ctx.step.tool, p.draft.appId || p.ctx.step.appId);
    return <AskOnceRow value={p.value as never} onChange={p.set} blocked={askOnceBlocked(found.action)} appLabel={found.appLabel} disabled={p.disabled} />;
}

function renderNote(p: RenderProps): ReactElement | null {
    if (!p.hint) return null;
    if (p.field.kind === 'note' && p.field.tone === 'warning') return <Banner tone="warning">{p.hint}</Banner>;
    return <Text variant="caption" tone="tertiary">{p.hint}</Text>;
}

function renderDisplay(p: RenderProps): ReactElement | null {
    if (p.field.kind !== 'display') return null;
    return <InfoRow label={p.label ?? ''} value={p.field.show(p.draft, p.ctx)} />;
}

export const RENDERERS: Record<FieldKind, Renderer> = {
    template: renderTemplate,
    binding: (p) => <BindingInput {...common(p)} value={p.value} onChange={p.set} prompt={p.prompt} />,
    path: (p) => <BindingInput mode="path" {...common(p)} value={text(p.value)} onChange={p.set} prompt={p.prompt} list={p.field.kind === 'path' && p.field.list} />,
    text: (p) => <SuggestText {...common(p)} value={text(p.value)} onChange={p.set} prompt={p.prompt} suggestions={p.field.suggest?.(p.draft, p.ctx) ?? []} />,
    multiline: (p) => <MultilineField {...common(p)} value={p.value} onChange={p.set} prompt={p.prompt} maxLength={p.field.kind === 'multiline' ? p.field.maxLength : undefined} />,
    number: (p) =>
        p.field.kind === 'number' ? (
            <NumberField
                {...common(p)}
                value={p.value}
                onChange={p.set}
                prompt={p.prompt}
                min={p.field.min}
                max={p.field.max}
                integer={p.field.integer}
                allowBlank={p.field.allowBlank}
                suffix={p.field.suffix ? say(p.t, p.field.suffix) : undefined}
            />
        ) : null,
    toggle: (p) => (
        <ToggleField
            value={p.value === true}
            onChange={p.set}
            label={p.label ?? ''}
            description={p.field.kind === 'toggle' ? say(p.t, resolveWords(p.field.description, p.draft, p.ctx)) || p.hint : p.hint}
            disabled={p.disabled}
        />
    ),
    select: (p) => <SelectField {...common(p)} value={text(p.value)} options={options(p)} onChange={p.set} prompt={p.prompt} />,
    segmented: renderSegmented,
    choice: (p) => <ChoiceField {...common(p)} value={text(p.value)} options={options(p)} onChange={p.set} />,
    chips: (p) => <ChipsField {...common(p)} value={Array.isArray(p.value) ? (p.value as string[]) : []} options={options(p)} onChange={p.set} />,
    duration: (p) => <DurationField {...common(p)} value={p.value} onChange={p.set} />,
    rows: (p) => <RowsEditor {...common(p)} value={p.value as Inputs} onChange={p.set} keepEmpty={p.field.kind === 'rows' && p.field.keepEmpty} />,
    list: (p) => <StringListField {...common(p)} value={Array.isArray(p.value) ? p.value : []} onChange={p.set} prompt={p.field.example} />,
    templateMap: (p) => <TemplateMap value={p.value} onChange={p.set} disabled={p.disabled} />,
    schema: renderSchema,
    contract: (p) => (p.field.kind === 'contract' ? <ContractInputs contract={p.field.contract(p.ctx)} value={p.value} onChange={p.set} disabled={p.disabled} /> : null),
    extraction: (p) => <ExtractionRows value={p.value} onChange={p.set} />,
    forEach: (p) => <ForEachRow value={p.value as ForEach | null} onChange={p.set} sampleRoot={p.ctx.sampleRoot} hint={p.hint} disabled={p.disabled} />,
    retry: (p) => <RetryRow value={p.value} forEach={p.draft.forEach} onChange={p.set} disabled={p.disabled} />,
    askOnce: renderAskOnce,
    note: renderNote,
    display: renderDisplay,
};
