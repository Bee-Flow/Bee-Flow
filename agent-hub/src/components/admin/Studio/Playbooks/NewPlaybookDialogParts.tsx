import { Loader2, Lock, Play, Sparkles, Wand2 } from 'lucide-react';
import useTranslation from '@/hooks/useTranslation';
import { tierI18nKey, tierLabel } from '@/components/licensing/tierMeta';
import SegmentedControl from '@/components/shared/SegmentedControl';
import { PRIMARY_ACTION_STYLE } from '@/components/shared/StudioSectionHeader';
import ChoiceCard from '../Datatables/ChoiceCard';
import { canLinkNextcloud } from '../Datatables/datatableDisplay';
import { RECIPES } from './recipes';
import { inputsOf } from './recipeForm';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { OrgGroup } from '@/api/queries/orgGroups';
import type { PermissionUser } from '@/hooks/usePermissionCheck';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { ApiError, NewRecipeInput, RecipeDoc, RecipePreviewProps, StaticRecipe } from './NewPlaybookDialog.types';

/**
 * The sections of the new-playbook dialog: the footer, the recipe picker,
 * the describe box, the table, input, tier and approver fields, and the
 * preview of what the AI wrote. Moved out of NewPlaybookDialog.tsx verbatim.
 */

export const DESCRIBE_ID = '__describe__';
// The description is the whole dialog now that a playbook is described rather
// than picked. It opens at eight lines and grows with what is typed, up to
// half a tall screen — a person pasting five paragraphs was writing into a
// three-line slot (owner, 2026-09-16).
export const DESCRIBE_MIN_PX = 200;
export const DESCRIBE_MAX_PX = 420;

const label = 'block text-xs font-medium mb-1';
const input = 'w-full rounded-lg px-3 py-2 text-sm';
const inputStyle = { background: 'var(--bg-primary)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' };

/** The datatables an existing-table playbook can write into. */
export type PickableTable = { id: string; name: string; rowCount: number; managedKind: string };

// A built-in recipe keeps its translated words (recipes.js); a document
// the server or the AI wrote speaks for itself.
const known = (r: RecipeDoc) => (RECIPES as readonly StaticRecipe[]).find((x) => x.id === r.id) || null;
const recipeTitle = (r: RecipeDoc, t: TranslateFn) => (known(r) ? t(known(r)?.labelKey, known(r)?.labelFallback) : r.title);
const recipeBlurb = (r: RecipeDoc, t: TranslateFn) => (known(r) ? t(known(r)?.blurbKey, known(r)?.blurbFallback) : r.description);

/** What a failed compose says, in the GUI's language where it can. */
export function composeErrorMessage(e: unknown, t: TranslateFn) {
    const findings = Array.isArray((e as ApiError)?.body?.errors) ? (e as ApiError).body.errors.map((x) => x.message).filter(Boolean) : [];
    // compose_truncated: the answer hit the model's output cap — a
    // shorter ask is the fix, so the sentence says that in the GUI's
    // language rather than echoing the server's English.
    const message = (e as ApiError)?.code === 'compose_truncated'
        ? t('playbooks.new.err_compose_truncated', 'The playbook came out longer than the model can write in one answer — describe fewer screens and steps, or split it into two playbooks.')
        : ((e as Error)?.message || t('playbooks.new.err_compose', 'The AI could not write a runnable playbook — try a more concrete description.'));
    return findings.length ? `${message} ${findings.join(' ')}` : message;
}

export interface CreatePayloadArgs {
    recipe: RecipeDoc | null;
    recipeId: string;
    composed: RecipeDoc | null;
    title: string;
    hasTable: boolean;
    tableMode: string;
    datatableId: string;
    inputs: Record<string, string>;
    tier: string;
    locale: string;
    approverGroupId: string;
    description: string;
}

/** The body of the create call: the recipe (or its id), the name and the options. */
export function createPayloadFor({
    recipe, recipeId, composed, title, hasTable, tableMode, datatableId, inputs, tier, locale, approverGroupId, description,
}: CreatePayloadArgs) {
    const cleanInputs: Record<string, string> = {};
    for (const i of inputsOf(recipe)) cleanInputs[i.key] = String(inputs[i.key] || '').trim();
    return {
        ...(recipeId === DESCRIBE_ID ? { recipe: composed } : { recipeId: recipe?.id }),
        title: title.trim(),
        options: {
            tableMode: hasTable ? tableMode : undefined,
            datatableId: hasTable && tableMode === 'existing' ? datatableId : undefined,
            inputs: cleanInputs,
            folderPath: cleanInputs.folderPath,
            tier,
            locale,
            approverGroupId: approverGroupId || undefined,
            // What the person typed, verbatim — the designer phase reads
            // it so the app it draws is the one that was asked for.
            ask: recipeId === DESCRIBE_ID && description.trim() ? description.trim() : undefined,
        },
    };
}

export function NewPlaybookFooter({ onClose, onStart, canStart, busy }: { onClose: () => void; onStart: () => void; canStart: boolean; busy: boolean }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={onClose} className="h-8 px-3 rounded-[10px] text-xs font-medium text-[var(--text-secondary)]">
                {t('playbooks.new.cancel', 'Cancel')}
            </button>
            <button
                type="button"
                onClick={onStart}
                disabled={!canStart}
                data-testid="playbook-start"
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold disabled:opacity-50"
                style={PRIMARY_ACTION_STYLE}
            >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Play className="w-3.5 h-3.5" aria-hidden="true" />}
                {t('playbooks.new.start', 'Start')}
            </button>
        </div>
    );
}

export function RecipePicker({ recipes, recipeId, onPick }: { recipes: RecipeDoc[]; recipeId: string; onPick: (id: string) => void }) {
    const { t } = useTranslation();
    return (
        <div>
            <span className={label} style={{ color: 'var(--text-secondary)' }}>{t('playbooks.new.recipe', 'Playbook')}</span>
            <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
                {recipes.map((r) => (
                    <ChoiceCard
                        key={r.id}
                        name="playbook-recipe"
                        kind="playbook"
                        checked={recipeId === r.id}
                        onChange={() => onPick(r.id)}
                        title={recipeTitle(r, t)}
                        blurb={recipeBlurb(r, t)}
                        note={(r.phases || []).map((p) => p.label || p.key).join(' → ')}
                    />
                ))}
                <ChoiceCard
                    name="playbook-recipe"
                    kind="playbook"
                    checked={recipeId === DESCRIBE_ID}
                    onChange={() => onPick(DESCRIBE_ID)}
                    title={t('playbooks.new.describe', 'Describe it')}
                    blurb={t('playbooks.new.describe_blurb', 'Say what should be read, stored and built — the AI writes the phases.')}
                    note={t('playbooks.new.describe_note', 'Table → automation → first rows → app → more')}
                />
            </div>
        </div>
    );
}

export interface DescribeSectionProps {
    describeRef: RefObject<HTMLTextAreaElement | null>;
    description: string;
    onDescriptionChange: (el: HTMLTextAreaElement) => void;
    onCompose: () => void;
    composing: boolean;
    composed: RecipeDoc | null;
    composeError: string | null;
    composeWarnings: string[];
}

export function DescribeSection({
    describeRef, description, onDescriptionChange, onCompose, composing, composed, composeError, composeWarnings,
}: DescribeSectionProps) {
    const { t } = useTranslation();
    return (
        <div data-testid="playbook-describe">
            <label className={label} htmlFor="pbk-describe" style={{ color: 'var(--text-secondary)' }}>{t('playbooks.new.describe_label', 'What should this playbook build?')}</label>
            <textarea
                id="pbk-describe"
                ref={describeRef}
                className={`${input} resize-y`}
                style={{ ...inputStyle, minHeight: DESCRIBE_MIN_PX, maxHeight: DESCRIBE_MAX_PX }}
                value={description}
                onChange={(e) => onDescriptionChange(e.target)}
                maxLength={2000}
                placeholder={t('playbooks.new.describe_placeholder', 'e.g. Read the supplier contracts in /Contracten into a table with supplier, start date, end date and amount, then build an app that shows which contracts end within 90 days.')}
            />
            <div className="mt-2 flex items-center gap-2">
                <button type="button" onClick={onCompose} disabled={!description.trim() || composing} data-testid="playbook-compose" className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold disabled:opacity-50 [color:var(--type-ai)]! [border:1px_solid_var(--type-ai)] [background:color-mix(in_srgb,var(--type-ai)_8%,transparent)]">
                    {composing ? <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Wand2 className="w-3.5 h-3.5" aria-hidden="true" />}
                    {composed ? t('playbooks.new.compose_again', 'Write it again') : t('playbooks.new.compose', 'Let the AI write the phases')}
                </button>
                {composing && <span className="text-[11px] text-[var(--text-secondary)]">{t('playbooks.new.composing', 'Writing the playbook…')}</span>}
            </div>
            {composeError && <p className="mt-2 text-xs [color:var(--error-ink,var(--error))]!" role="alert">{composeError}</p>}
            {composed && <RecipePreview recipe={composed} warnings={composeWarnings} t={t} />}
        </div>
    );
}

export function NameField({ title, onTitleChange }: { title: string; onTitleChange: (value: string) => void }) {
    const { t } = useTranslation();
    return (
        <div>
            <label className={label} htmlFor="pbk-title" style={{ color: 'var(--text-secondary)' }}>{t('playbooks.new.name', 'Name')}</label>
            <input id="pbk-title" className={input} style={inputStyle} value={title} onChange={(e) => onTitleChange(e.target.value)} maxLength={120} />
        </div>
    );
}

export interface TableModeFieldProps {
    tableMode: string;
    setTableMode: (mode: string) => void;
    tables: PickableTable[] | null;
    datatableId: string;
    setDatatableId: (id: string) => void;
}

export function TableModeField({ tableMode, setTableMode, tables, datatableId, setDatatableId }: TableModeFieldProps) {
    const { t } = useTranslation();
    return (
        <div>
            <span className={label} style={{ color: 'var(--text-secondary)' }}>{t('playbooks.new.table_mode_generic', 'Where the rows go')}</span>
            <SegmentedControl
                ariaLabel={t('playbooks.new.table_mode_generic', 'Where the rows go')}
                value={tableMode}
                onChange={setTableMode}
                size="sm"
                options={[
                    { value: 'new', label: t('playbooks.new.table_new', 'A new table') },
                    { value: 'existing', label: t('playbooks.new.table_existing', 'An existing table') },
                ]}
            />
            {tableMode === 'existing' && (
                <div className="mt-2">
                    <label className={label} htmlFor="pbk-table" style={{ color: 'var(--text-secondary)' }}>{t('playbooks.new.pick_table', 'Table')}</label>
                    {tables === null ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)]"><Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />{t('playbooks.new.loading_tables', 'Loading your tables…')}</span>
                    ) : (
                        <select id="pbk-table" className={input} style={inputStyle} value={datatableId} onChange={(e) => setDatatableId(e.target.value)} data-testid="playbook-table-pick">
                            <option value="">{t('playbooks.new.pick_table_placeholder', 'Pick a table…')}</option>
                            {tables.map((x) => (
                                <option key={x.id} value={x.id}>{x.name}{Number.isFinite(x.rowCount) ? ` · ${x.rowCount}` : ''}{x.managedKind === 'nextcloud_table' ? ' · Nextcloud' : ''}</option>
                            ))}
                        </select>
                    )}
                    <p className="mt-1 text-[11px] text-[var(--text-secondary)]">{t('playbooks.new.table_existing_hint', 'Own table or a Nextcloud mirror — you need edit rights; its columns are checked in the first phase.')}</p>
                </div>
            )}
        </div>
    );
}

export interface RecipeInputFieldsProps {
    recipe: RecipeDoc;
    inputs: Record<string, string>;
    setInputs: Dispatch<SetStateAction<Record<string, string>>>;
    folderProblems: unknown[];
    user: PermissionUser | null;
}

export function RecipeInputFields({ recipe, inputs, setInputs, folderProblems, user }: RecipeInputFieldsProps) {
    const { t } = useTranslation();
    return (inputsOf(recipe) as NewRecipeInput[]).map((i) => (
        <div key={i.key}>
            <label className={label} htmlFor={`pbk-in-${i.key}`} style={{ color: 'var(--text-secondary)' }}>{i.key === 'folderPath' && recipe.source === 'builtin' ? t('playbooks.new.folder', 'Nextcloud folder with the invoices') : i.label}</label>
            <input id={`pbk-in-${i.key}`} data-testid={`playbook-input-${i.key}`} className={input} style={inputStyle} value={inputs[i.key] || ''} onChange={(e) => setInputs((prev) => ({ ...prev, [i.key]: e.target.value }))} placeholder={i.placeholder || (i.kind === 'folder' ? '/Invoices' : '')} />
            {i.kind === 'folder' && folderProblems.includes(i) && <p className="mt-1 text-[11px] [color:var(--error-ink,var(--error))]!">{t('playbooks.new.err_folder', 'The folder is an absolute Nextcloud path, e.g. /Invoices.')}</p>}
            {i.kind === 'folder' && !canLinkNextcloud(user) && <p className="mt-1 text-[11px] text-[var(--text-secondary)]">{t('playbooks.new.folder_hint', 'The automation reads this folder through your Nextcloud connection.')}</p>}
        </div>
    ));
}

export interface TierFieldProps {
    tier: string;
    setTier: (tier: string) => void;
    tierKeys: readonly string[];
    modelTiers: Parameters<typeof tierLabel>[1] | null;
}

export function TierField({ tier, setTier, tierKeys, modelTiers }: TierFieldProps) {
    const { t } = useTranslation();
    return (
        <div>
            <span className={label} style={{ color: 'var(--text-secondary)' }}>{t('playbooks.new.tier', 'Model')}</span>
            <SegmentedControl
                ariaLabel={t('playbooks.new.tier', 'Model')}
                value={tier}
                onChange={setTier}
                size="sm"
                options={tierKeys.map((k) => ({ value: k, label: t(tierI18nKey(k), tierLabel(k, modelTiers || {})) }))}
            />
            <p className="mt-1 text-[11px] text-[var(--text-secondary)]">{t('playbooks.new.tier_hint_generic', 'Every phase of this playbook is built on the tier you pick here; Auto picks one per turn.')}</p>
        </div>
    );
}

export interface ApproverFieldProps {
    locked: boolean;
    approverGroupId: string;
    setApproverGroupId: (id: string) => void;
    groups: OrgGroup[] | null;
}

export function ApproverField({ locked, approverGroupId, setApproverGroupId, groups }: ApproverFieldProps) {
    const { t } = useTranslation();
    return (
        <div>
            <label className={label} htmlFor="pbk-approver" style={{ color: 'var(--text-secondary)' }}>{t('playbooks.new.approver', 'Approver group (optional)')}</label>
            {locked ? (
                <p className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                    <Lock className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('playbooks.new.approvals_locked', 'The approval flow needs the Enterprise plan — the playbook skips that phase.')}
                </p>
            ) : (
                <select id="pbk-approver" className={input} style={inputStyle} value={approverGroupId} onChange={(e) => setApproverGroupId(e.target.value)}>
                    <option value="">{t('playbooks.new.approver_me', 'Me (the owner)')}</option>
                    {(groups || []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
            )}
        </div>
    );
}

export function RecipePreview({ recipe, warnings = [], t }: RecipePreviewProps) {
    const fields = recipe.table && Array.isArray(recipe.table.fields) ? recipe.table.fields : [];
    // The document itself carries the marker too (it is stored with the
    // playbook), so a preview of a re-opened document says the same thing.
    const synthesized = warnings.includes('table_synthesized') || (Array.isArray(recipe.warnings) && recipe.warnings.includes('table_synthesized'));
    return (
        <div className="mt-3 rounded-xl p-3 [background:var(--bg-primary)] [border:1px_solid_var(--border-default)]" data-testid="playbook-recipe-preview">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-primary)]">
                <Sparkles className="w-3.5 h-3.5 [color:var(--type-ai)]" aria-hidden="true" />{recipe.title}
            </div>
            {recipe.description && <p className="text-[11px] mt-0.5 text-[var(--text-secondary)]">{recipe.description}</p>}
            <ol className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-[var(--text-secondary)]">
                {(recipe.phases || []).map((p, i) => (
                    <li key={p.key} className="inline-flex items-center gap-1">
                        {i > 0 && <span aria-hidden="true">→</span>}
                        <span className="px-1.5 py-0.5 rounded-md [background:var(--bg-card)] [border:1px_solid_var(--border-default)] [color:var(--text-primary)]">{p.label || p.key}</span>
                    </li>
                ))}
            </ol>
            {fields.length > 0 && (
                <p className="mt-2 text-[11px] text-[var(--text-secondary)]">
                    {t('playbooks.new.preview_columns', 'Columns: {list}', { list: fields.map((f) => `${f.name || f.key} (${f.type})`).join(', ') })}
                </p>
            )}
            {fields.length > 0 && synthesized && (
                <p className="mt-1 text-[11px] [color:var(--warning-ink,var(--warning))]!" data-testid="playbook-columns-synthesized">
                    {t('playbooks.new.preview_columns_synthesized', 'The AI did not declare these columns — they were read from the placeholders in its briefs. Check them before you start.')}
                </p>
            )}
        </div>
    );
}
