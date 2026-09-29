import { Loader2, Lock, Play, Sparkles, Wand2 } from 'lucide-react';
import React, { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { playbooksApi } from './playbooksApi';
import { initialInputValues, inputsOf, needsApprover } from './recipeForm';
import { RECIPES } from './recipes';
import useTranslation, { readingLocale } from '../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import { DEPTH_TIER_KEYS, configuredTierKeys, tierI18nKey, tierLabel } from '../../../licensing/tierMeta';
import Modal from '../../../shared/Modal';
import SegmentedControl from '../../../shared/SegmentedControl';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import ChoiceCard from '../Datatables/ChoiceCard';
import { canLinkNextcloud } from '../Datatables/datatableDisplay';
import { datatablesApi } from '../Datatables/datatablesApi';

const DESCRIBE_ID = '__describe__';
// The description is the whole dialog now that a playbook is described rather
// than picked. It opens at eight lines and grows with what is typed, up to
// half a tall screen — a person pasting five paragraphs was writing into a
// three-line slot (owner, 2026-09-16).
const DESCRIBE_MIN_PX = 200;
const DESCRIBE_MAX_PX = 420;

// Until the server answers (and when it answers with nothing usable) the
// picker keeps the two tiers the playbook has always had — dropping to Auto
// alone because a fetch failed would silently change what gets built.
const FALLBACK_TIERS = Object.freeze(['fast', 'auto']);


/**
 * Start a playbook. Two doors: a built-in recipe (the server lists them as
 * documents), or DESCRIBE IT — a few sentences the Fast model turns into a
 * recipe document (phases, table columns, inputs) that is previewed here
 * before anything is created. The form below the recipe is generic: it
 * reads the document — its inputs (a Nextcloud folder, a text), whether
 * there is a table (new or existing), whether a phase needs an approver.
 */
/** The static fallback list, as documents, until the server answers. */
function staticRecipes(t = (_k, d) => d) {
    return RECIPES.map((r) => ({ id: r.id, title: t(r.labelKey, r.labelFallback), description: r.blurbFallback, labelKey: r.labelKey, labelFallback: r.labelFallback, blurbKey: r.blurbKey, blurbFallback: r.blurbFallback, table: { fields: [] }, inputs: [{ key: 'folderPath', label: t('playbooks.new.folder', 'Nextcloud folder with the invoices'), kind: 'folder', default: r.defaults.folderPath }], phases: r.phases.map((key) => ({ key, kind: key === 'approvals' ? 'app_turn' : key, label: key, requires: key === 'approvals' ? 'approvals' : undefined })) }));
}

// The keys that have to be translated before this dialog counts as being in
// another language: its own title, the describe box it is built around, and
// the phase words the recipe preview prints.
const LANGUAGE_ANCHORS = Object.freeze([
    'playbooks.new.title',
    'playbooks.new.describe_label',
    'playbooks.phase.table',
]);

export default function NewPlaybookDialog({ user = null, onClose, onCreated, hasLicenseFeature = () => false }) {
    // `resolvedLocale` is the language ON SCREEN (not the stored preference: a
    // Dutch browser on a deployment whose Dutch catalogue never loaded reads
    // English). THE DEMO SPEAKS IT — its table columns, the briefs the two
    // builders read, the app's labels. There is no picker here on purpose
    // (owner, 2026-09-16): the language of a playbook is the language of Bee
    // Flow, set once in the user's settings, not a second dial per build.
    const { t, locale: chosenLocale, strings } = useTranslation();
    // The language THIS DIALOG is rendered in — measured against the very keys
    // it renders, not against "some catalogue is loaded". A deployment whose
    // Dutch catalogue does not cover the playbook screens shows them in
    // English, and then the demo is built in English too (owner, 2026-09-16:
    // an English dialog was producing Dutch columns and phase labels).
    const locale = readingLocale(chosenLocale, strings, LANGUAGE_ANCHORS);
    const [recipes, setRecipes] = useState(() => staticRecipes(t));
    // A title the person typed survives a language switch; one we filled in follows it.
    const [titleDirty, setTitleDirty] = useState(false);
    // Describe it is the door (owner, 2026-09-16). A built-in recipe only
    // appears when the server still offers one; with none — today — there is
    // nothing to pick and the dialog opens straight on the description.
    const [recipeId, setRecipeId] = useState(RECIPES[0]?.id || DESCRIBE_ID);
    const [description, setDescription] = useState('');
    const describeRef = useRef(null);
    // Grow to the content instead of scrolling inside itself. Reset to `auto`
    // first, or the box can only ever get taller.
    const growDescribe = useCallback((el) => {
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(Math.max(el.scrollHeight, DESCRIBE_MIN_PX), DESCRIBE_MAX_PX)}px`;
    }, []);
    useEffect(() => { growDescribe(describeRef.current); }, [growDescribe, description]);
    const [composed, setComposed] = useState(null);      // the AI's document, previewed
    // The composer's warning codes for that document ('table_synthesized' =
    // the server guessed the columns from the briefs' placeholders because
    // the model declared none; shown beside the columns, never silent).
    const [composeWarnings, setComposeWarnings] = useState([]);
    const [composing, setComposing] = useState(false);
    const [composeError, setComposeError] = useState(null);
    const recipe = useMemo(() => (recipeId === DESCRIBE_ID ? composed : recipes.find((r) => r.id === recipeId) || null), [recipeId, recipes, composed]);
    const [title, setTitle] = useState(recipes[0]?.title || '');
    const [tableMode, setTableMode] = useState('new');
    const [datatableId, setDatatableId] = useState('');
    const [inputs, setInputs] = useState(() => initialInputValues(recipes[0]));
    const [tier, setTier] = useState('fast');
    const [modelTiers, setModelTiers] = useState(null);
    const [approverGroupId, setApproverGroupId] = useState('');
    const [tables, setTables] = useState(null);
    const [groups, setGroups] = useState(null);
    const [approvalsAllowed, setApprovalsAllowed] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    // Re-read on a language switch: the recipes come back with their phases,
    // columns and inputs in it, which is what the preview shows.
    const applyRecipes = useEffectEvent((r) => {
        setApprovalsAllowed(!!r?.approvalsAllowed);
        if (Array.isArray(r?.recipes) && r.recipes.length) {
            setRecipes(r.recipes);
            const first = r.recipes.find((x) => x.id === recipeId) || r.recipes[0];
            if (first && recipeId !== DESCRIBE_ID) {
                if (!titleDirty) setTitle(first.title || '');
                setInputs((prev) => ({ ...initialInputValues(first), ...prev }));
            }
        }
    });
    useEffect(() => {
        let alive = true;
        playbooksApi.recipes(locale)
            .then((r) => { if (alive) applyRecipes(r); })
            .catch(() => { if (alive) setApprovalsAllowed(false); });
        return () => { alive = false; };
    }, [locale]);

    // The tiers this person may actually pick. Same permission- and task-aware
    // endpoint as both builders (a playbook drives them, so 'automation' is the
    // task type), narrowed to the DEPTH axis: Flow, Swarm, Write and custom
    // tiers are a KIND of work, and a playbook's phases are pinned to one depth.
    useEffect(() => {
        let alive = true;
        authFetch(`${API_BASE}/ai/config/tiers-for-user?taskType=automation`)
            .then((r) => (r.ok ? r.json() : null))
            .then((b) => { if (alive) setModelTiers(b && typeof b === 'object' && !Array.isArray(b) ? b : null); })
            .catch(() => { if (alive) setModelTiers(null); });
        return () => { alive = false; };
    }, []);

    const tierKeys = useMemo(() => {
        const keys = configuredTierKeys(modelTiers || {}).filter((k) => DEPTH_TIER_KEYS.includes(k));
        // Auto alone means nothing is configured for this user yet — that is
        // the "no answer" case, not a one-option picker.
        return keys.filter((k) => k !== 'auto').length ? keys : FALLBACK_TIERS;
    }, [modelTiers]);

    // A tier that vanished from the list (a group's allowedTiers changed while
    // the dialog was open) must not ride along to the server.
    useEffect(() => {
        if (!tierKeys.includes(tier)) setTier(tierKeys.includes('fast') ? 'fast' : tierKeys[0]);
    }, [tierKeys, tier]);

    const hasTable = !!(recipe && recipe.table && Array.isArray(recipe.table.fields));
    useEffect(() => {
        if (!hasTable || tableMode !== 'existing' || tables) return;
        let alive = true;
        datatablesApi.list().then((b) => { if (alive) setTables(Array.isArray(b?.datatables) ? b.datatables : []); }).catch(() => { if (alive) setTables([]); });
        return () => { alive = false; };
    }, [hasTable, tableMode, tables]);

    const wantsApprover = needsApprover(recipe);
    useEffect(() => {
        if (!approvalsAllowed || !wantsApprover || groups) return;
        let alive = true;
        authFetch(`${API_BASE}/auth/groups`).then((r) => (r.ok ? r.json() : [])).then((b) => {
            if (!alive) return;
            const list = Array.isArray(b) ? b : (Array.isArray(b?.groups) ? b.groups : []);
            setGroups(list);
        }).catch(() => { if (alive) setGroups([]); });
        return () => { alive = false; };
    }, [approvalsAllowed, wantsApprover, groups]);

    const pickRecipe = (id) => {
        setRecipeId(id);
        setError(null);
        setTitleDirty(false);
        if (id === DESCRIBE_ID) {
            if (composed) { setTitle(composed.title || ''); setInputs(initialInputValues(composed)); }
            return;
        }
        const r = recipes.find((x) => x.id === id);
        if (r) { setTitle(r.title || ''); setInputs(initialInputValues(r)); }
    };

    const compose = async () => {
        if (!description.trim() || composing) return;
        setComposing(true);
        setComposeError(null);
        try {
            const body = await playbooksApi.composeRecipe(description.trim(), locale);
            setComposed(body.recipe);
            setComposeWarnings(Array.isArray(body.warnings) ? body.warnings : []);
            setTitleDirty(false);
            setTitle(body.recipe.title || '');
            setInputs(initialInputValues(body.recipe));
        } catch (e) {
            const findings = Array.isArray(e?.body?.errors) ? e.body.errors.map((x) => x.message).filter(Boolean) : [];
            // compose_truncated: the answer hit the model's output cap — a
            // shorter ask is the fix, so the sentence says that in the GUI's
            // language rather than echoing the server's English.
            const message = e?.code === 'compose_truncated'
                ? t('playbooks.new.err_compose_truncated', 'The playbook came out longer than the model can write in one answer — describe fewer screens and steps, or split it into two playbooks.')
                : (e?.message || t('playbooks.new.err_compose', 'The AI could not write a runnable playbook — try a more concrete description.'));
            setComposeError(findings.length ? `${message} ${findings.join(' ')}` : message);
        } finally {
            setComposing(false);
        }
    };

    const folderProblems = inputsOf(recipe).filter((i) => i.kind === 'folder' && !(String(inputs[i.key] || '').trim().startsWith('/') && String(inputs[i.key] || '').trim().length <= 300));
    const tableOk = !hasTable || tableMode === 'new' || !!datatableId;
    const canStart = !!recipe && title.trim().length > 0 && folderProblems.length === 0 && tableOk && !busy;

    const start = async () => {
        if (!canStart) return;
        setBusy(true);
        setError(null);
        try {
            const cleanInputs = {};
            for (const i of inputsOf(recipe)) cleanInputs[i.key] = String(inputs[i.key] || '').trim();
            const body = await playbooksApi.create({
                ...(recipeId === DESCRIBE_ID ? { recipe: composed } : { recipeId: recipe.id }),
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
            });
            onCreated?.(body.playbook);
        } catch (e) {
            setError(e?.code === 'bad_options' || e?.code === 'recipe_invalid' ? (e.message || t('playbooks.new.err_options', 'Check the options.')) : (e?.message || t('playbooks.new.err_create', 'Could not start the playbook.')));
            setBusy(false);
        }
    };

    const label = 'block text-xs font-medium mb-1';
    const input = 'w-full rounded-lg px-3 py-2 text-sm';
    const inputStyle = { background: 'var(--bg-primary)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' };
    // A built-in recipe keeps its translated words (recipes.js); a document
    // the server or the AI wrote speaks for itself.
    const known = (r) => RECIPES.find((x) => x.id === r.id) || null;
    const recipeTitle = (r) => (known(r) ? t(known(r).labelKey, known(r).labelFallback) : r.title);
    const recipeBlurb = (r) => (known(r) ? t(known(r).blurbKey, known(r).blurbFallback) : r.description);

    return (
        <Modal
            open
            onClose={onClose}
            size="xl"
            title={t('playbooks.new.title', 'New playbook')}
            description={t('playbooks.new.subtitle', 'The AI builds in phases and stops after each one for your go-ahead.')}
            footer={(
                <div className="flex items-center justify-end gap-2">
                    <button type="button" onClick={onClose} className="h-8 px-3 rounded-[10px] text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                        {t('playbooks.new.cancel', 'Cancel')}
                    </button>
                    <button
                        type="button"
                        onClick={start}
                        disabled={!canStart}
                        data-testid="playbook-start"
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold disabled:opacity-50"
                        style={PRIMARY_ACTION_STYLE}
                    >
                        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Play className="w-3.5 h-3.5" aria-hidden="true" />}
                        {t('playbooks.new.start', 'Start')}
                    </button>
                </div>
            )}
        >
            <div className="space-y-4">
                {recipes.length > 0 && (
                <div>
                    <span className={label} style={{ color: 'var(--text-secondary)' }}>{t('playbooks.new.recipe', 'Playbook')}</span>
                    <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
                        {recipes.map((r) => (
                            <ChoiceCard
                                key={r.id}
                                name="playbook-recipe"
                                kind="playbook"
                                checked={recipeId === r.id}
                                onChange={() => pickRecipe(r.id)}
                                title={recipeTitle(r)}
                                blurb={recipeBlurb(r)}
                                note={(r.phases || []).map((p) => p.label || p.key).join(' → ')}
                            />
                        ))}
                        <ChoiceCard
                            name="playbook-recipe"
                            kind="playbook"
                            checked={recipeId === DESCRIBE_ID}
                            onChange={() => pickRecipe(DESCRIBE_ID)}
                            title={t('playbooks.new.describe', 'Describe it')}
                            blurb={t('playbooks.new.describe_blurb', 'Say what should be read, stored and built — the AI writes the phases.')}
                            note={t('playbooks.new.describe_note', 'Table → automation → first rows → app → more')}
                        />
                    </div>
                </div>
                )}

                {recipeId === DESCRIBE_ID && (
                    <div data-testid="playbook-describe">
                        <label className={label} htmlFor="pbk-describe" style={{ color: 'var(--text-secondary)' }}>{t('playbooks.new.describe_label', 'What should this playbook build?')}</label>
                        <textarea
                            id="pbk-describe"
                            ref={describeRef}
                            className={`${input} resize-y`}
                            style={{ ...inputStyle, minHeight: DESCRIBE_MIN_PX, maxHeight: DESCRIBE_MAX_PX }}
                            value={description}
                            onChange={(e) => { setDescription(e.target.value); growDescribe(e.target); }}
                            maxLength={2000}
                            placeholder={t('playbooks.new.describe_placeholder', 'e.g. Read the supplier contracts in /Contracten into a table with supplier, start date, end date and amount, then build an app that shows which contracts end within 90 days.')}
                        />
                        <div className="mt-2 flex items-center gap-2">
                            <button type="button" onClick={compose} disabled={!description.trim() || composing} data-testid="playbook-compose" className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold disabled:opacity-50" style={{ color: 'var(--type-ai)', border: '1px solid var(--type-ai)', background: 'color-mix(in srgb, var(--type-ai) 8%, transparent)' }}>
                                {composing ? <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Wand2 className="w-3.5 h-3.5" aria-hidden="true" />}
                                {composed ? t('playbooks.new.compose_again', 'Write it again') : t('playbooks.new.compose', 'Let the AI write the phases')}
                            </button>
                            {composing && <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t('playbooks.new.composing', 'Writing the playbook…')}</span>}
                        </div>
                        {composeError && <p className="mt-2 text-xs" style={{ color: 'var(--error-ink, var(--error))' }} role="alert">{composeError}</p>}
                        {composed && <RecipePreview recipe={composed} warnings={composeWarnings} t={t} />}
                    </div>
                )}

                {recipe && (
                    <>
                        <div>
                            <label className={label} htmlFor="pbk-title" style={{ color: 'var(--text-secondary)' }}>{t('playbooks.new.name', 'Name')}</label>
                            <input id="pbk-title" className={input} style={inputStyle} value={title} onChange={(e) => { setTitleDirty(true); setTitle(e.target.value); }} maxLength={120} />
                        </div>

                        {hasTable && (
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
                                            <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}><Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />{t('playbooks.new.loading_tables', 'Loading your tables…')}</span>
                                        ) : (
                                            <select id="pbk-table" className={input} style={inputStyle} value={datatableId} onChange={(e) => setDatatableId(e.target.value)} data-testid="playbook-table-pick">
                                                <option value="">{t('playbooks.new.pick_table_placeholder', 'Pick a table…')}</option>
                                                {tables.map((x) => (
                                                    <option key={x.id} value={x.id}>{x.name}{Number.isFinite(x.rowCount) ? ` · ${x.rowCount}` : ''}{x.managedKind === 'nextcloud_table' ? ' · Nextcloud' : ''}</option>
                                                ))}
                                            </select>
                                        )}
                                        <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t('playbooks.new.table_existing_hint', 'Own table or a Nextcloud mirror — you need edit rights; its columns are checked in the first phase.')}</p>
                                    </div>
                                )}
                            </div>
                        )}

                        {inputsOf(recipe).map((i) => (
                            <div key={i.key}>
                                <label className={label} htmlFor={`pbk-in-${i.key}`} style={{ color: 'var(--text-secondary)' }}>{i.key === 'folderPath' && recipe.source === 'builtin' ? t('playbooks.new.folder', 'Nextcloud folder with the invoices') : i.label}</label>
                                <input id={`pbk-in-${i.key}`} data-testid={`playbook-input-${i.key}`} className={input} style={inputStyle} value={inputs[i.key] || ''} onChange={(e) => setInputs((prev) => ({ ...prev, [i.key]: e.target.value }))} placeholder={i.placeholder || (i.kind === 'folder' ? '/Invoices' : '')} />
                                {i.kind === 'folder' && folderProblems.includes(i) && <p className="mt-1 text-[11px]" style={{ color: 'var(--error-ink, var(--error))' }}>{t('playbooks.new.err_folder', 'The folder is an absolute Nextcloud path, e.g. /Invoices.')}</p>}
                                {i.kind === 'folder' && !canLinkNextcloud(user) && <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t('playbooks.new.folder_hint', 'The automation reads this folder through your Nextcloud connection.')}</p>}
                            </div>
                        ))}

                        <div>
                            <span className={label} style={{ color: 'var(--text-secondary)' }}>{t('playbooks.new.tier', 'Model')}</span>
                            <SegmentedControl
                                ariaLabel={t('playbooks.new.tier', 'Model')}
                                value={tier}
                                onChange={setTier}
                                size="sm"
                                options={tierKeys.map((k) => ({ value: k, label: t(tierI18nKey(k), tierLabel(k, modelTiers || {})) }))}
                            />
                            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t('playbooks.new.tier_hint_generic', 'Every phase of this playbook is built on the tier you pick here; Auto picks one per turn.')}</p>
                        </div>

                        {wantsApprover && (
                            <div>
                                <label className={label} htmlFor="pbk-approver" style={{ color: 'var(--text-secondary)' }}>{t('playbooks.new.approver', 'Approver group (optional)')}</label>
                                {approvalsAllowed === false || (approvalsAllowed === null && !hasLicenseFeature('approvals')) ? (
                                    <p className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
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
                        )}
                    </>
                )}

                {error && <p className="text-xs" style={{ color: 'var(--error-ink, var(--error))' }} role="alert">{error}</p>}
            </div>
        </Modal>
    );
}

/** What the AI wrote: the phases in order, the table's columns, the inputs. */
function RecipePreview({ recipe, warnings = [], t }) {
    const fields = recipe.table && Array.isArray(recipe.table.fields) ? recipe.table.fields : [];
    // The document itself carries the marker too (it is stored with the
    // playbook), so a preview of a re-opened document says the same thing.
    const synthesized = warnings.includes('table_synthesized') || (Array.isArray(recipe.warnings) && recipe.warnings.includes('table_synthesized'));
    return (
        <div className="mt-3 rounded-xl p-3" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-default)' }} data-testid="playbook-recipe-preview">
            <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                <Sparkles className="w-3.5 h-3.5" style={{ color: 'var(--type-ai)' }} aria-hidden="true" />{recipe.title}
            </div>
            {recipe.description && <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>{recipe.description}</p>}
            <ol className="mt-2 flex flex-wrap items-center gap-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                {(recipe.phases || []).map((p, i) => (
                    <li key={p.key} className="inline-flex items-center gap-1">
                        {i > 0 && <span aria-hidden="true">→</span>}
                        <span className="px-1.5 py-0.5 rounded-md" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}>{p.label || p.key}</span>
                    </li>
                ))}
            </ol>
            {fields.length > 0 && (
                <p className="mt-2 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                    {t('playbooks.new.preview_columns', 'Columns: {list}', { list: fields.map((f) => `${f.name || f.key} (${f.type})`).join(', ') })}
                </p>
            )}
            {fields.length > 0 && synthesized && (
                <p className="mt-1 text-[11px]" style={{ color: 'var(--warning-ink, var(--warning))' }} data-testid="playbook-columns-synthesized">
                    {t('playbooks.new.preview_columns_synthesized', 'The AI did not declare these columns — they were read from the placeholders in its briefs. Check them before you start.')}
                </p>
            )}
        </div>
    );
}
