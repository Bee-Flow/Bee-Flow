import { useId, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { BLOCK_LIMITS, FRAME_SANDBOX, isBlockName } from '@shared/blockTemplate/index.mjs';
import CustomCssEditor from '@/components/automation/Builder/flow/settings/formStyle/CustomCssEditor';
import type { CustomCssEditorVariant } from '@/components/automation/Builder/flow/settings/formStyle/CustomCssEditor';
import FormField from '@/components/shared/FormField';
import SegmentedControl from '@/components/shared/SegmentedControl';
import useTranslation from '@/hooks/useTranslation';
import ActionPicker from '../ActionPicker';
import { registerInspector } from '../registry';
import { updateNodeProps } from '../../state/definitionOps';
import { BLOCK_CSS_MAX, sanitizeBlockCssClient } from '../../runtime/components/customBlock/blockCss';
import { blockEntries, buildBlockFrame, type BlockFinding, type BlockValue } from '../../runtime/components/customBlock/blockPipeline';
import { FRAME_VARIABLES } from '../../runtime/components/customBlock/blockTheme';
import BindingField from './BindingField';
import { INPUT_CLS } from './kit';
import type { AppDefinition, AppNode, PanelProps } from '../appDefinition';

/**
 * custom_block: the builder's own HTML template and stylesheet (spec:
 * server/appStudio/componentSpecs/types/custom_block.js). Two text tabs, what the sanitiser
 * would leave out of the template with its line, a preview, and the two lists that say what
 * the template may read (inputs) and run (events).
 *
 * The preview is built by the same code as the block on the page (blockPipeline.ts), in the
 * same kind of frame. It knows the inputs with a fixed value only: the canvas shows the block
 * with the app's data.
 */

type Tab = 'template' | 'css';
type T = ReturnType<typeof useTranslation>['t'];
type BlockPatch = (patch: Partial<BlockValue>, base?: AppDefinition) => void;

interface BlockProps { block?: BlockValue | null }

const TEXT_AREA = 'w-full px-2 py-1.5 rounded-md text-[11px] leading-snug font-mono border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)]';
const HINT = 'text-[11px] text-[var(--text-tertiary)]';
const ROW_BUTTON = 'inline-flex items-center gap-1 rounded border border-[var(--border-default)] px-2 py-1 text-xs text-[var(--text-secondary)] disabled:opacity-50';

/** Code, not prose: shown as written in every language. */
const TEMPLATE_EXAMPLE = '<ul>\n  <li data-each="rows as row">{{ row.name }}</li>\n</ul>';
const CSS_EXAMPLE = '.card { padding: 12px; border: 1px solid var(--bf-border); }';
const LOOK_VARIABLES = FRAME_VARIABLES.map(([, name]) => name).join(' ');

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The inputs that hold a fixed value, by name: what the panel's preview can know. */
function staticScope(inputs: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, binding] of blockEntries(inputs)) {
        const b = binding as { kind?: unknown; value?: unknown } | null;
        out[name] = b && b.kind === 'static' ? b.value : null;
    }
    return out;
}

/** `map` with the entry `from` renamed to `to`, in place; unchanged when `to` is taken. */
function renamed(map: Record<string, unknown>, from: string, to: string): Record<string, unknown> {
    if (from === to || Object.hasOwn(map, to)) return map;
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(map)) out[name === from ? to : name] = value;
    return out;
}

function without(map: Record<string, unknown>, name: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [entry, value] of Object.entries(map)) if (entry !== name) out[entry] = value;
    return out;
}

/** A name nobody uses yet: `base`, then `base2`, `base3`, … */
function freshName(map: Record<string, unknown>, base: string): string {
    if (!Object.hasOwn(map, base)) return base;
    let n = 2;
    while (Object.hasOwn(map, `${base}${n}`)) n += 1;
    return `${base}${n}`;
}

function Findings({ findings, t }: { findings: BlockFinding[]; t: T }) {
    if (!findings.length) return null;
    return (
        <div role="status" data-custom-block-findings={findings.length} className="rounded-md border border-[var(--border-default)] px-2 py-1.5">
            <p className="text-[11px] font-medium text-[var(--warning-ink)]">{t('studio_apps_block.findings_title', 'Left out when the block is saved:')}</p>
            <ul className="mt-1 flex flex-col gap-0.5 text-[11px] text-[var(--text-secondary)]">
                {findings.slice(0, 20).map((finding, i) => (
                    <li key={`${finding.line}:${i}`}>
                        <span className="font-mono text-[var(--text-primary)]">{t('studio_apps_block.finding_line', 'Line {line}', { line: finding.line })}</span>{' '}
                        {finding.message}
                    </li>
                ))}
            </ul>
        </div>
    );
}

function TextTabs({ block, patch, disabled, findings, t }: { block: BlockValue; patch: BlockPatch; disabled: boolean; findings: BlockFinding[]; t: T }) {
    const [tab, setTab] = useState<Tab>('template');
    const id = useId();
    const template = textOf(block.template);
    const cssVariant = useMemo<CustomCssEditorVariant>(() => ({
        sanitize: sanitizeBlockCssClient,
        max: BLOCK_CSS_MAX,
        disabled,
        placeholder: CSS_EXAMPLE,
        label: t('studio_apps_block.css_label', 'Stylesheet of this block'),
        hint: t('studio_apps_block.css_hint', 'Applies inside this block only. The look of the app is in the variables below.'),
        removedTitle: t('studio_apps_block.css_removed_title', 'Left out when the block is shown:'),
        sheetTitle: t('studio_apps_block.css_sheet_title', 'Variables of the app look'),
        sheet: <p className="font-mono text-[10px] leading-snug text-[var(--text-primary)] break-words">{LOOK_VARIABLES}</p>,
    }), [disabled, t]);
    return (
        <div className="flex min-w-0 flex-col gap-2" data-custom-block-tab={tab}>
            <SegmentedControl<Tab>
                size="sm"
                value={tab}
                onChange={setTab}
                ariaLabel={t('studio_apps_block.tabs', 'Which text to edit')}
                options={[
                    { value: 'template', label: t('studio_apps_block.tab_template', 'Template') },
                    { value: 'css', label: t('studio_apps_block.tab_css', 'CSS') },
                ]}
            />
            {tab === 'template' ? (
                <div className="space-y-1">
                    <label htmlFor={`${id}-template`} className="block text-[11px] uppercase tracking-wide text-[var(--text-secondary)]">{t('studio_apps_block.template_label', 'HTML template')}</label>
                    <textarea
                        id={`${id}-template`}
                        rows={12}
                        spellCheck={false}
                        value={template}
                        maxLength={BLOCK_LIMITS.MAX_TEMPLATE_CHARS}
                        disabled={disabled}
                        placeholder={TEMPLATE_EXAMPLE}
                        aria-describedby={`${id}-template-hint`}
                        onChange={(e) => patch({ template: e.target.value })}
                        className={TEXT_AREA}
                    />
                    <p id={`${id}-template-hint`} className={HINT}>
                        {t('studio_apps_block.template_hint', 'HTML without script. {{ formula }} writes a value as text, data-if shows an element when a formula is true, data-each="rows as row" repeats it. A formula reads the inputs below and nothing else.')}
                    </p>
                    <p className={HINT}>{t('studio_apps_block.count', '{count} of {max} characters', { count: template.length, max: BLOCK_LIMITS.MAX_TEMPLATE_CHARS })}</p>
                    <Findings findings={findings} t={t} />
                </div>
            ) : (
                <CustomCssEditor value={textOf(block.css)} onChange={(css) => patch({ css: css || undefined })} variant={cssVariant} />
            )}
        </div>
    );
}

function Preview({ doc, problems, t }: { doc: string; problems: string[]; t: T }) {
    return (
        <FormField label={t('studio_apps_block.preview', 'Preview')}>
            <iframe
                title={t('studio_apps_block.preview', 'Preview')}
                srcDoc={doc}
                sandbox={FRAME_SANDBOX}
                referrerPolicy="no-referrer"
                allow=""
                tabIndex={-1}
                data-custom-block-preview="true"
                className="block h-40 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)]"
            />
            <p className={`mt-1 ${HINT}`}>{t('studio_apps_block.preview_hint', 'With the inputs that hold a fixed value. The canvas shows the block with the data of the app.')}</p>
            {problems.length ? <p className="mt-1 break-words text-[11px] text-[var(--error-ink)]" role="status">{problems[0]}</p> : null}
        </FormField>
    );
}

function NameInput({ name, onRename, label, disabled }: { name: string; onRename: (next: string) => void; label: string; disabled: boolean }) {
    const invalid = !isBlockName(name);
    return (
        <input
            type="text"
            className={INPUT_CLS}
            value={name}
            onChange={(e) => onRename(e.target.value.trim())}
            aria-label={label}
            aria-invalid={invalid || undefined}
            placeholder={label}
            spellCheck={false}
            disabled={disabled}
        />
    );
}

function InputList({ node, definition, block, patch, disabled, t }: { node: AppNode; definition: AppDefinition; block: BlockValue; patch: BlockPatch; disabled: boolean; t: T }) {
    const inputs = Object.fromEntries(blockEntries(block.inputs));
    const names = Object.keys(inputs);
    return (
        <FormField label={t('studio_apps_block.inputs', 'Inputs')}>
            <div className="flex min-w-0 flex-col gap-3" data-custom-block-inputs={names.length}>
                {names.map((name, i) => (
                    <div key={i} className="flex flex-col gap-2 rounded-md border border-[var(--border-default)] p-2">
                        <div className="flex items-center gap-2">
                            <NameInput name={name} label={t('studio_apps_block.input_name', 'Name, as the template reads it')} disabled={disabled} onRename={(next) => patch({ inputs: renamed(inputs, name, next) })} />
                            <button type="button" className={ROW_BUTTON} disabled={disabled} onClick={() => patch({ inputs: without(inputs, name) })} aria-label={t('studio_apps_block.remove_input', 'Remove the input {name}', { name })}>
                                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                        </div>
                        <BindingField
                            label={t('studio_apps_block.input_value', 'Value')}
                            value={inputs[name] as never}
                            onChange={(value) => patch({ inputs: { ...inputs, [name]: value } })}
                            definition={definition}
                            node={node}
                            componentType="custom_block"
                            disabled={disabled}
                        />
                    </div>
                ))}
                <button
                    type="button"
                    className={`${ROW_BUTTON} self-start`}
                    disabled={disabled || names.length >= BLOCK_LIMITS.MAX_INPUTS}
                    onClick={() => patch({ inputs: { ...inputs, [freshName(inputs, 'value')]: { kind: 'static', value: '' } } })}
                >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('studio_apps_block.add_input', 'Add input')}
                </button>
                <p className={HINT}>{t('studio_apps_block.inputs_hint', 'The only data the template sees. Each value is looked up by the app for the person viewing it.')}</p>
            </div>
        </FormField>
    );
}

function EventList({ node, definition, onCommit, block, patch, disabled, t }: { node: AppNode; definition: AppDefinition; onCommit: (next: AppDefinition) => void; block: BlockValue; patch: BlockPatch; disabled: boolean; t: T }) {
    const events = Object.fromEntries(blockEntries(block.events));
    const names = Object.keys(events);
    return (
        <FormField label={t('studio_apps_block.events', 'Events')}>
            <div className="flex min-w-0 flex-col gap-3" data-custom-block-events={names.length}>
                {names.map((name, i) => (
                    <div key={i} className="flex flex-col gap-2 rounded-md border border-[var(--border-default)] p-2">
                        <div className="flex items-center gap-2">
                            <NameInput name={name} label={t('studio_apps_block.event_name', 'Event name, as in data-emit')} disabled={disabled} onRename={(next) => patch({ events: renamed(events, name, next) })} />
                            <button type="button" className={ROW_BUTTON} disabled={disabled} onClick={() => patch({ events: without(events, name) })} aria-label={t('studio_apps_block.remove_event', 'Remove the event {name}', { name })}>
                                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                        </div>
                        <ActionPicker
                            value={typeof events[name] === 'string' ? events[name] as string : ''}
                            definition={definition}
                            node={node}
                            disabled={disabled}
                            ariaLabel={t('studio_apps_block.event_action', 'Action for the event {name}', { name })}
                            onPick={(actionId, def) => patch({ events: { ...events, [name]: actionId || null } }, def)}
                            onEditDefinition={onCommit}
                        />
                    </div>
                ))}
                <button
                    type="button"
                    className={`${ROW_BUTTON} self-start`}
                    disabled={disabled || names.length >= BLOCK_LIMITS.MAX_EVENTS}
                    onClick={() => patch({ events: { ...events, [freshName(events, 'pick')]: null } })}
                >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('studio_apps_block.add_event', 'Add event')}
                </button>
                <p className={HINT}>{t('studio_apps_block.events_hint', 'A <button data-emit="name"> in the template runs the action. The action reads the result of data-value as value.')}</p>
            </div>
        </FormField>
    );
}

export default function CustomBlockInspector({ node, definition, onCommit, disabled = false }: PanelProps<BlockProps>) {
    const { t, locale } = useTranslation();
    const stored = node.props?.block;
    const block = useMemo<BlockValue>(() => (stored && typeof stored === 'object' ? stored : {}), [stored]);
    const patch: BlockPatch = (change, base = definition) => {
        const next: Record<string, unknown> = { template: '', ...block, ...change };
        for (const name of Object.keys(next)) if (next[name] === undefined) delete next[name];
        onCommit(updateNodeProps(base, node.id, { block: next }) as AppDefinition);
    };
    const frame = useMemo(() => buildBlockFrame({ block, scope: staticScope(block.inputs), events: [], theme: {}, dark: false, lang: locale }), [block, locale]);
    return (
        <div className="flex flex-col gap-4" data-custom-block-panel="true">
            <p className="text-xs text-[var(--text-secondary)]">
                {t('studio_apps_block.intro', 'Your own HTML and CSS, for what no component can draw. A block holds no script and loads nothing: it shows the inputs you list, and its buttons run the actions you wire.')}
            </p>
            <TextTabs block={block} patch={patch} disabled={disabled} findings={frame.findings} t={t} />
            {frame.empty ? null : <Preview doc={frame.doc} problems={frame.problems} t={t} />}
            <InputList node={node} definition={definition} block={block} patch={patch} disabled={disabled} t={t} />
            <EventList node={node} definition={definition} onCommit={onCommit} block={block} patch={patch} disabled={disabled} t={t} />
        </div>
    );
}

registerInspector('custom_block', CustomBlockInspector, { props: ['block'] });
