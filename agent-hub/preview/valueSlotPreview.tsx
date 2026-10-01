/**
 * Value slot gallery: every state of the value-slot building blocks
 * (src/components/automation/Builder/valueSlot/) on the fixture data of the
 * mapping preview, so they can be screenshotted before they are wired into
 * the step drawer. Dev only: open
 * http://localhost:<vite>/mapping-preview.html?view=slots&theme=dark
 */
import React, { useState } from 'react';
import { evaluate } from '@shared/expr/index.mjs';
import * as parse from '@shared/expr/parse.mjs';
import { liftLegacy } from '@shared/mapping/index.mjs';
import type { MappingSource, PickIntent } from '@shared/mapping/index.mjs';
import { useTranslation } from '../src/hooks/useTranslation';
import ValueChip from '../src/components/automation/Builder/valueSlot/ValueChip';
import PickSentence from '../src/components/automation/Builder/valueSlot/PickSentence';
import PickOptions, { previewText, resolvePreview } from '../src/components/automation/Builder/valueSlot/PickOptions';
import TargetPopover from '../src/components/automation/Builder/valueSlot/TargetPopover';
import { formulaSummary, pickLabel } from '../src/components/automation/Builder/valueSlot/usePickLabel';
import {
    SlotRegistryContext, useRegisterSlot, useSlotRegistry, useSlotRegistryContext, type SlotHandle,
} from '../src/components/automation/Builder/valueSlot/useSlotRegistry';
import { onSourceDragOver, readSourceDrop, startSourceDrag, type DraggedSource } from '../src/components/automation/Builder/valueSlot/slotDnd';
import { FETCH_OUTPUT, SCENARIOS, TRIGGER_OUTPUT } from './mappingFixture';

const SAMPLE = { trigger: { output: TRIGGER_OUTPUT }, steps: { fetch: { output: FETCH_OUTPUT } }, vars: {} };
const STEP_LABELS = new Map([['fetch', 'Berichten ophalen']]);

const EMAIL: MappingSource = { root: 'trigger', path: ['customer', 'email'] };
const PRODUCTS: MappingSource = { root: 'trigger', path: ['orders', 'lines', 'product'] };
const LINES: MappingSource = { root: 'trigger', path: ['orders', 'lines'] };
const TOTALS: MappingSource = { root: 'trigger', path: ['orders', 'total'] };
const TEXT = { as: 'text' as const, multiLine: true };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section className="flex flex-col gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-4">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">{title}</h2>
            {children}
        </section>
    );
}

function Row({ caption, children }: { caption: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-1">
            <div className="text-[11px] uppercase tracking-wide text-[var(--text-tertiary)]">{caption}</div>
            <div className="flex min-w-0 flex-col gap-1">{children}</div>
        </div>
    );
}

function count(source: MappingSource): number {
    const all = resolvePreview(source, { take: 'all', as: 'list' }, SAMPLE);
    return Array.isArray(all) ? all.length : 0;
}

function Chips() {
    const { t } = useTranslation();
    const email = { from: EMAIL, take: 'one' as const };
    const products = { from: PRODUCTS, take: 'all' as const };
    return (
        <Section title="ValueChip">
            <Row caption="One value, with its example">
                <ValueChip label={pickLabel(t, email)} preview={previewText(resolvePreview(EMAIL, { take: 'one', as: 'text' }, SAMPLE))} onOpen={() => {}} onRemove={() => {}} />
            </Row>
            <Row caption="A list, with its count">
                <ValueChip label={pickLabel(t, products)} count={count(PRODUCTS)} preview={previewText(resolvePreview(PRODUCTS, { take: 'all', as: 'text', join: 'comma' }, SAMPLE))} onOpen={() => {}} onRemove={() => {}} />
            </Row>
            <Row caption="Stale: the source is gone">
                <ValueChip label={pickLabel(t, email)} state="stale" onRepick={() => {}} onRemove={() => {}} />
            </Row>
            <Row caption="Formula (a legacy expression)">
                <ValueChip label="" state="formula" summary={formulaSummary(t, SCENARIOS.formula.subject as never, STEP_LABELS)} onOpen={() => {}} onRemove={() => {}} />
            </Row>
            <Row caption="Formula (a legacy text with values)">
                <ValueChip label="" state="formula" summary={formulaSummary(t, (SCENARIOS['list-in-text'] as Record<string, never>).body)} onOpen={() => {}} />
            </Row>
        </Section>
    );
}

function Sentences() {
    const columns = [{ key: 'product', label: 'Product' }, { key: 'qty', label: 'Qty' }, { key: 'price', label: 'Price' }];
    const [column, setColumn] = useState<string | null>('product');
    const n = count(PRODUCTS);
    return (
        <Section title="PickSentence">
            <Row caption="List into text (lines / commas / bullets)">
                <PickSentence intent={{ take: 'all', as: 'text', join: 'lines' }} count={n} onChange={() => {}} />
                <PickSentence intent={{ take: 'all', as: 'text', join: 'comma' }} count={n} onChange={() => {}} />
                <PickSentence intent={{ take: 'all', as: 'text', join: 'bullets' }} count={n} onChange={() => {}} />
            </Row>
            <Row caption="Into a list field">
                <PickSentence intent={{ take: 'all', as: 'list' }} count={n} onChange={() => {}} />
                <PickSentence intent={{ take: 'one', as: 'list' }} onChange={() => {}} />
            </Row>
            <Row caption="Many values into a number field (amber)">
                <PickSentence intent={{ take: 'first', as: 'number' }} count={count(TOTALS)} warning onChange={() => {}} />
            </Row>
            <Row caption="The number">
                <PickSentence intent={{ take: 'count', as: 'number' }} count={n} onChange={() => {}} />
            </Row>
            <Row caption="A whole table into a list field: which column">
                <PickSentence intent={{ take: 'all', as: 'list' }} columns={columns} column={column} onColumn={setColumn} />
                <PickSentence intent={{ take: 'all', as: 'list' }} columns={columns} column={null} onColumn={() => {}} />
            </Row>
        </Section>
    );
}

function Options() {
    const [text, setText] = useState<PickIntent>({ take: 'all', as: 'text', join: 'lines' });
    const { t } = useTranslation();
    return (
        <Section title="PickOptions (live previews)">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <Row caption="Products into a multi-line text">
                    <PickOptions
                        source={PRODUCTS} sample={SAMPLE} slot={TEXT} value={text} onSelect={setText}
                        label={pickLabel(t, { from: PRODUCTS, take: 'all' })}
                        onFormula={() => {}} onRowIndex={() => {}} onRepeatShortcut={() => {}}
                    />
                </Row>
                <Row caption="A table into text: one line per row">
                    <PickOptions source={LINES} sample={SAMPLE} slot={TEXT} onSelect={() => {}} label={pickLabel(t, { from: LINES, take: 'all' })} />
                </Row>
                <Row caption="Many values into a number">
                    <PickOptions source={TOTALS} sample={SAMPLE} slot={{ as: 'number' }} onSelect={() => {}} label={pickLabel(t, { from: TOTALS, take: 'first' })} />
                </Row>
            </div>
        </Section>
    );
}

function Lifted() {
    const { t } = useTranslation();
    const rows = Object.entries(SCENARIOS).flatMap(([scenario, inputs]) => Object.entries(inputs).map(([field, binding]) => ({ scenario, field, binding })));
    return (
        <Section title="Stored bindings as they will show (liftLegacy)">
            {rows.map(({ scenario, field, binding }) => {
                const pick = liftLegacy(binding, SAMPLE, null, { evaluate, parse });
                return (
                    <Row key={`${scenario}.${field}`} caption={`${scenario} › ${field}`}>
                        {pick
                            ? <ValueChip label={pickLabel(t, pick)} count={pick.take === 'all' ? count(pick.from) : null} preview={previewText(resolvePreview(pick.from, pick, SAMPLE))} />
                            : <ValueChip label="" state="formula" summary={formulaSummary(t, binding as never, STEP_LABELS)} />}
                    </Row>
                );
            })}
        </Section>
    );
}

const FIELDS = [
    { id: 'to', label: 'To', required: true },
    { id: 'cc', label: 'Cc' },
    { id: 'subject', label: 'Subject', required: true },
    { id: 'priority', label: 'Priority' },
];

function DemoField({ id, label, required }: { id: string; label: string; required?: boolean }) {
    const registry = useSlotRegistryContext();
    const { t } = useTranslation();
    const [value, setValue] = useState<DraggedSource | null>(null);
    const handle: SlotHandle = { id, label, required, isEmpty: () => !value, accept: setValue };
    const { onFocus } = useRegisterSlot(registry, handle);
    return (
        <div
            tabIndex={0}
            onFocus={onFocus}
            onDragOver={onSourceDragOver}
            onDrop={(e) => { const v = readSourceDrop(e); if (v) setValue(v); }}
            className="flex min-h-[32px] items-center gap-2 rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] px-2 py-1 text-[12px] focus:outline focus:outline-[var(--accent-primary)]"
        >
            <span className="w-16 shrink-0 text-[var(--text-tertiary)]">{label}{required ? ' *' : ''}</span>
            {value && <ValueChip label={pickLabel(t, { from: value.source, take: 'one' }, value)} onRemove={() => setValue(null)} />}
        </div>
    );
}

function Registry() {
    const registry = useSlotRegistry();
    const { t } = useTranslation();
    const [asking, setAsking] = useState<DraggedSource | null>(null);
    const sources: DraggedSource[] = [
        { source: EMAIL, shape: 'single' },
        { source: { root: 'trigger', path: ['customer', 'name'] }, shape: 'single' },
        { source: { root: 'steps', id: 'fetch', path: ['data', 'results', 'subject'] }, shape: 'list', groupLabel: 'Berichten ophalen' },
    ];
    const pick = (v: DraggedSource) => { if (!registry.deliver(v)) setAsking(v); };
    return (
        <SlotRegistryContext.Provider value={registry}>
            <Section title="Where should this go? (click a value with no field focused, or drag it onto a field)">
                <div className="flex flex-wrap gap-2">
                    {sources.map(v => (
                        <button
                            key={JSON.stringify(v.source)}
                            type="button"
                            draggable
                            onDragStart={(e) => startSourceDrag(e, v)}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => pick(v)}
                            className="rounded-md border border-[var(--border-default)] px-2 py-1 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                        >
                            {pickLabel(t, { from: v.source, take: 'one' }, v)}
                        </button>
                    ))}
                </div>
                <div className="flex flex-col gap-1.5">
                    {FIELDS.map(f => <DemoField key={f.id} {...f} />)}
                </div>
                {asking && (
                    <TargetPopover
                        targets={registry.emptySlots()}
                        valueLabel={pickLabel(t, { from: asking.source, take: 'one' }, asking)}
                        onChoose={(id) => { registry.deliverTo(id, asking); setAsking(null); }}
                        onClose={() => setAsking(null)}
                    />
                )}
                {!asking && (
                    <TargetPopover targets={FIELDS} valueLabel={pickLabel(t, { from: EMAIL, take: 'one' })} onChoose={() => {}} onClose={() => {}} autoFocus={false} />
                )}
            </Section>
        </SlotRegistryContext.Provider>
    );
}

export default function ValueSlotGallery() {
    return (
        <div className="min-h-[100dvh] bg-[var(--bg-primary)] p-4 text-[var(--text-primary)]">
            <div className="mx-auto flex max-w-5xl flex-col gap-4">
                <h1 className="text-[16px] font-semibold">Value slot building blocks</h1>
                <Chips />
                <Sentences />
                <Options />
                <Lifted />
                <Registry />
            </div>
        </div>
    );
}
