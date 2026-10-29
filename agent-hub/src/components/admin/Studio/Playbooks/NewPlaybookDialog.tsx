import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { playbooksApi } from './playbooksApi';
import { initialInputValues, inputsOf, needsApprover } from './recipeForm';
import { RECIPES } from './recipes';
import useTranslation, { readingLocale } from '@/hooks/useTranslation';
import { useModelTiersQuery } from '@/api/queries/modelTiers';
import Modal from '@/components/shared/Modal';
import {
    ApproverField, DESCRIBE_ID, DescribeSection, NameField, NewPlaybookFooter, RecipeInputFields, RecipePicker, TableModeField,
    TierField, composeErrorMessage, createPayloadFor, type PickableTable,
} from './NewPlaybookDialogParts';
import { depthTierKeys, useApproverGroups, useExistingTables, useGrowDescribe } from './useNewPlaybookData';
import type { OrgGroup } from '@/api/queries/orgGroups';
import type { RecipeDoc, StaticRecipe, ApiError, NewPlaybookDialogProps } from './NewPlaybookDialog.types';

/** The static fallback list, as documents, until the server answers. */
function staticRecipes(t: (key: string, fallback: string) => string = (_k, d) => d): RecipeDoc[] {
    return (RECIPES as readonly StaticRecipe[]).map((r) => ({ id: r.id, title: t(r.labelKey, r.labelFallback), description: r.blurbFallback, labelKey: r.labelKey, labelFallback: r.labelFallback, blurbKey: r.blurbKey, blurbFallback: r.blurbFallback, table: { fields: [] }, inputs: [{ key: 'folderPath', label: t('playbooks.new.folder', 'Nextcloud folder with the invoices'), kind: 'folder', default: r.defaults.folderPath }], phases: r.phases.map((key: string) => ({ key, kind: key === 'approvals' ? 'app_turn' : key, label: key, requires: key === 'approvals' ? 'approvals' : undefined })) }));
}

// The keys that have to be translated before this dialog counts as being in
// another language: its own title, the describe box it is built around, and
// the phase words the recipe preview prints.
const LANGUAGE_ANCHORS = Object.freeze([
    'playbooks.new.title',
    'playbooks.new.describe_label',
    'playbooks.phase.table',
]);

export default function NewPlaybookDialog({ user = null, onClose, onCreated, hasLicenseFeature = () => false }: NewPlaybookDialogProps) {
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
    const [recipes, setRecipes] = useState<RecipeDoc[]>(() => staticRecipes(t));
    // A title the person typed survives a language switch; one we filled in follows it.
    const [titleDirty, setTitleDirty] = useState(false);
    // Describe it is the door (owner, 2026-09-16). A built-in recipe only
    // appears when the server still offers one; with none — today — there is
    // nothing to pick and the dialog opens straight on the description.
    const [recipeId, setRecipeId] = useState(RECIPES[0]?.id || DESCRIBE_ID);
    const [description, setDescription] = useState('');
    const describeRef = useRef<HTMLTextAreaElement>(null);
    const growDescribe = useGrowDescribe(describeRef, description);
    const [composed, setComposed] = useState<RecipeDoc | null>(null);      // the AI's document, previewed
    // The composer's warning codes for that document ('table_synthesized' =
    // the server guessed the columns from the briefs' placeholders because
    // the model declared none; shown beside the columns, never silent).
    const [composeWarnings, setComposeWarnings] = useState<string[]>([]);
    const [composing, setComposing] = useState(false);
    const [composeError, setComposeError] = useState<string | null>(null);
    const recipe = useMemo(() => (recipeId === DESCRIBE_ID ? composed : recipes.find((r) => r.id === recipeId) || null), [recipeId, recipes, composed]);
    const [title, setTitle] = useState(recipes[0]?.title || '');
    const [tableMode, setTableMode] = useState('new');
    const [datatableId, setDatatableId] = useState('');
    const [inputs, setInputs] = useState(() => initialInputValues(recipes[0]));
    const [tier, setTier] = useState('fast');
    const [approverGroupId, setApproverGroupId] = useState('');
    const [tables, setTables] = useState<PickableTable[] | null>(null);
    const [groups, setGroups] = useState<OrgGroup[] | null>(null);
    const [approvalsAllowed, setApprovalsAllowed] = useState<boolean | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Re-read on a language switch: the recipes come back with their phases,
    // columns and inputs in it, which is what the preview shows.
    const applyRecipes = useEffectEvent((r: { approvalsAllowed?: boolean; recipes?: RecipeDoc[] } | null) => {
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
    const modelTiers = useModelTiersQuery('automation').data ?? null;

    const tierKeys = useMemo(() => depthTierKeys(modelTiers), [modelTiers]);

    // A tier that vanished from the list (a group's allowedTiers changed while
    // the dialog was open) must not ride along to the server.
    useEffect(() => {
        if (!tierKeys.includes(tier)) setTier(tierKeys.includes('fast') ? 'fast' : tierKeys[0]);
    }, [tierKeys, tier]);

    const hasTable = !!(recipe && recipe.table && Array.isArray(recipe.table.fields));
    useExistingTables(hasTable, tableMode, tables, setTables);

    const wantsApprover = needsApprover(recipe);
    useApproverGroups(approvalsAllowed, wantsApprover, groups, setGroups);

    const pickRecipe = (id: string) => {
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
            setComposeError(composeErrorMessage(e, t));
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
            const body = await playbooksApi.create(createPayloadFor({
                recipe, recipeId, composed, title, hasTable, tableMode, datatableId, inputs, tier, locale, approverGroupId, description,
            }));
            onCreated?.(body.playbook);
        } catch (e) {
            setError((e as ApiError)?.code === 'bad_options' || (e as ApiError)?.code === 'recipe_invalid' ? ((e as Error).message || t('playbooks.new.err_options', 'Check the options.')) : ((e as Error)?.message || t('playbooks.new.err_create', 'Could not start the playbook.')));
            setBusy(false);
        }
    };

    return (
        <Modal
            open
            onClose={onClose}
            size="xl"
            title={t('playbooks.new.title', 'New playbook')}
            description={t('playbooks.new.subtitle', 'The AI builds in phases and stops after each one for your go-ahead.')}
            footer={<NewPlaybookFooter onClose={onClose} onStart={start} canStart={canStart} busy={busy} />}
        >
            <div className="space-y-4">
                {recipes.length > 0 && <RecipePicker recipes={recipes} recipeId={recipeId} onPick={pickRecipe} />}

                {recipeId === DESCRIBE_ID && (
                    <DescribeSection
                        describeRef={describeRef}
                        description={description}
                        onDescriptionChange={(el) => { setDescription(el.value); growDescribe(el); }}
                        onCompose={compose}
                        composing={composing}
                        composed={composed}
                        composeError={composeError}
                        composeWarnings={composeWarnings}
                    />
                )}

                {recipe && (
                    <>
                        <NameField title={title} onTitleChange={(value) => { setTitleDirty(true); setTitle(value); }} />

                        {hasTable && (
                            <TableModeField
                                tableMode={tableMode}
                                setTableMode={setTableMode}
                                tables={tables}
                                datatableId={datatableId}
                                setDatatableId={setDatatableId}
                            />
                        )}

                        <RecipeInputFields recipe={recipe} inputs={inputs} setInputs={setInputs} folderProblems={folderProblems} user={user} />

                        <TierField tier={tier} setTier={setTier} tierKeys={tierKeys} modelTiers={modelTiers} />

                        {wantsApprover && (
                            <ApproverField
                                locked={approvalsAllowed === false || (approvalsAllowed === null && !hasLicenseFeature('approvals'))}
                                approverGroupId={approverGroupId}
                                setApproverGroupId={setApproverGroupId}
                                groups={groups}
                            />
                        )}
                    </>
                )}

                {error && <p className="text-xs [color:var(--error-ink,var(--error))]!" role="alert">{error}</p>}
            </div>
        </Modal>
    );
}
