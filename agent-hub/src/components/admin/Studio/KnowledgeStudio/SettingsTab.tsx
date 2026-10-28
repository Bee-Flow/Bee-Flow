import { useCallback, useEffect, useMemo, useState } from 'react';
import { knowledgeApi, type KnowledgeBase } from './knowledgeApi';
import useTranslation from '@/hooks/useTranslation';
import CategoryField from '@/components/agents/AgentWizard/CategoryField';
import DangerZone from '@/components/shared/DangerZone';
import type { CategoryRow } from '@/components/agents/AgentWizard/agentEditor.types';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { SettingsTabProps, NameFieldsProps } from './SettingsTab.types';
import { SURFACE_CARDS, SettingsTabSection2 } from './SettingsTabSection2';
import { SettingsTabSection } from './SettingsTabSection';
export { SURFACE_CARDS, attachedCount } from './SettingsTabSection2';

/**
 * Instellingen (Knowledge artboard 1c-left): name, description, where the
 * knowledge base may be used, who may see it, its category, and deleting it
 * with its consequences shown first.
 *
 * ── TWO QUESTIONS THAT LOOK LIKE ONE ────────────────────────────────
 * "Waar inzetbaar" and "Wie mag hem zien" sit next to each other and mean
 * completely different things, so they are drawn differently on purpose:
 *
 *   WHERE  is a set of SURFACES (`usage_contexts`) — which pickers offer this
 *          base. Ticking `ai_step` off does not hide anything from anybody; it
 *          stops the base appearing in the automation editor's picker.
 *   WHO    is the AUDIENCE (`is_published` + `shared_groups`) — the thing the
 *          server enforces at retrieval, on every surface, per person.
 *
 * Conflating them would let somebody untick a surface and believe they had
 * revoked access. The helper line under each says which is which.
 *
 * ── UNTICKING A SURFACE BREAKS NOTHING SILENTLY ─────────────────────
 * A base already attached to two agents stays attached when `agent` is
 * unticked — the server only refuses NEW links. So the card carries the
 * count from the Used-by list, and says so, rather than letting somebody
 * think they have detached anything.
 *
 * ── THE ICON PICKER IS GONE ─────────────────────────────────────────
 * `icon` still exists on the row (marketplace, mobile) and an image icon set
 * elsewhere is shown in the tile — but Studio does not offer the emoji/image
 * chooser any more. It made every knowledge base look like a decision about
 * decoration before it was a decision about content.
 */

/**
 * A base's surfaces, with the one rule that matters: a value that was never
 * expressed means EVERYWHERE, not nowhere. A NULL predates the column, and a
 * settings screen that drew every box unticked would invite somebody to
 * "fix" it by ticking one — silently removing the base from the other two.
 */
export function surfacesOf(kb: KnowledgeBase | null | undefined) {
    const raw = kb?.usage_contexts ?? kb?.usageContexts;
    if (raw === null || raw === undefined) return SURFACE_CARDS.map(c => c.id);
    let list = raw;
    if (typeof raw === 'string') {
        try { list = JSON.parse(raw); } catch { return SURFACE_CARDS.map(c => c.id); }
    }
    if (!Array.isArray(list)) return SURFACE_CARDS.map(c => c.id);
    return list.filter(v => typeof v === 'string');
}

export default function SettingsTab({
    kb,
    usage = null,
    unchecked = [],
    canManage = false,
    currentUserId = null,
    orgGroups = [],
    orgId = null,
    onSaved,
    onDeleted,
    onDuplicated,
    onNavigate,
}: SettingsTabProps) {
    const { t } = useTranslation();
    const [name, setName] = useState(kb?.name || '');
    const [description, setDescription] = useState(kb?.description || '');
    const [categories, setCategories] = useState<CategoryRow[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    // The fields follow the base when it is reloaded from the server, but not
    // while somebody is typing into them: the id is the identity, so a save
    // that returns the same row does not throw away a half-typed description.
    useEffect(() => {
        setName(kb?.name || '');
        setDescription(kb?.description || '');
    }, [kb?.id]);

    useEffect(() => {
        let alive = true;
        knowledgeApi.categories()
            .then((body) => { if (alive) setCategories(Array.isArray(body) ? body : (body?.categories || [])); })
            .catch(() => { if (alive) setCategories([]); });
        return () => { alive = false; };
    }, []);

    const surfaces = useMemo(() => surfacesOf(kb), [kb]);
    /**
     * The row arrives snake_case from `GET /api/kb/:id` and camelCase from the
     * decorated list. Normalised once here rather than with a `??` at every
     * use: a missed pair reads as "personal, unpublished, no groups", which is
     * the shape that draws a base as private when it is not.
     */
    const view = useMemo(() => ({
        orgId: kb?.organization_id ?? kb?.organizationId ?? null,
        isPublished: !!(kb?.is_published ?? kb?.isPublished),
        sharedGroups: kb?.shared_groups ?? kb?.sharedGroups ?? [],
        categoryId: kb?.category_id ?? kb?.categoryId ?? null,
    }), [kb]);
    const isPersonal = !view.orgId;

    const save = useCallback(async (patch: { usageContexts?: string[]; name?: string; organizationId?: string; description?: string; categoryId?: string | null }) => {
        if (!kb?.id) return;
        setSaving(true);
        setError(null);
        try {
            await knowledgeApi.update(kb.id, patch);
            await onSaved?.();
        } catch (e) {
            setError((e as Error)?.message || t('knowledge.settings.err_save', 'Could not save that change.'));
        } finally {
            setSaving(false);
        }
    }, [kb?.id, onSaved, t]);

    const toggleSurface = useCallback((surface: string) => {
        const next = surfaces.includes(surface)
            ? surfaces.filter(s => s !== surface)
            : [...surfaces, surface];
        // An empty list is a real answer meaning "nowhere", and the server
        // stores it — but a settings screen that lets the last tick go is a
        // screen that quietly removes a base from every picker on one click.
        if (next.length === 0) {
            setError(t('knowledge.settings.err_no_surface', 'A knowledge base has to be usable somewhere. Pick another place first.'));
            return;
        }
        save({ usageContexts: next });
    }, [surfaces, save, t]);

    const setAudience = useCallback(async (body: { isPublished: boolean; sharedGroups: string[] }) => {
        if (!kb?.id) return;
        setError(null);
        try {
            await knowledgeApi.setPublished(kb.id, body);
            await onSaved?.();
        } catch (e) {
            setError((e as Error)?.message || t('knowledge.settings.err_save', 'Could not save that change.'));
        }
    }, [kb?.id, onSaved, t]);

    const moveToOrg = useCallback(async () => {
        if (!orgId) return;
        await save({ organizationId: orgId });
    }, [orgId, save]);

    /**
     * A copy for a new use case.
     *
     * `withSources` is a CHOICE rather than a default, because the two answers
     * are wanted for different reasons: "the same shape, I will fill it
     * myself" and "the same shape, reading the same places". Documents never
     * copy either way — a copied source refills itself on its first refresh,
     * which is current content instead of a snapshot of somebody else's last
     * run.
     */
    const duplicate = useCallback(async (withSources: boolean) => {
        if (!kb?.id) return;
        setSaving(true);
        setError(null);
        try {
            const copy = await knowledgeApi.duplicate(kb.id, { withSources });
            await onDuplicated?.(copy);
        } catch (e) {
            setError((e as Error)?.message || t('knowledge.settings.err_duplicate', 'Could not duplicate this knowledge base.'));
        } finally {
            setSaving(false);
        }
    }, [kb?.id, onDuplicated, t]);

    const remove = useCallback(async (confirmedBreaking: boolean) => {
        const body = await knowledgeApi.remove((kb as KnowledgeBase).id, { confirm: confirmedBreaking });
        await onDeleted?.();
        return body;
    }, [kb?.id, onDeleted]);

    const fieldStyle = {
        background: 'var(--bg-secondary)',
        borderColor: 'var(--border-subtle)',
        color: 'var(--text-primary)',
        outlineColor: 'var(--accent-primary)',
    };

    return (
        <div className="flex flex-col gap-6 max-w-xl" data-testid="kb-tab-settings">
            {error && (
                <p className="text-xs text-[var(--error)]" role="alert">{error}</p>
            )}

            <NameFields
                t={t}
                fieldStyle={fieldStyle}
                name={name}
                description={description}
                setName={setName}
                setDescription={setDescription}
                disabled={!canManage}
                onCommitName={(v) => { if (v && v !== kb?.name) save({ name: v }); }}
                onCommitDescription={(v) => { if (v !== (kb?.description || '')) save({ description: v }); }}
            />

            {/* ── Where it can be used ──────────────────────────── */}
            <SettingsTabSection2 t={t} surfaces={surfaces} canManage={canManage} saving={saving} usage={usage} toggleSurface={toggleSurface} />

            {/* ── Who may see it ────────────────────────────────── */}
            <SettingsTabSection isPersonal={isPersonal} t={t} canManage={canManage} orgId={orgId} moveToOrg={moveToOrg} saving={saving} kb={kb} view={view} orgGroups={orgGroups} setAudience={setAudience} />

            {/* ── Category ──────────────────────────────────────── */}
            <section data-testid="kb-category">
                <CategoryField
                    t={t}
                    value={view.categoryId}
                    categories={categories}
                    onChange={(categoryId) => save({ categoryId })}
                />
            </section>

            {/* ── Duplicate ─────────────────────────────────────── */}
            {canManage && kb?.id && (
                <section className="flex flex-col gap-2" data-testid="kb-duplicate">
                    <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
                        {t('knowledge.settings.duplicate_title', 'Make a copy')}
                    </h3>
                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            disabled={saving}
                            onClick={() => duplicate(false)}
                            data-testid="kb-duplicate-shell"
                            className="px-3 py-1.5 rounded-lg text-xs font-medium border disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 [border-color:var(--border-subtle)] [color:var(--text-secondary)]! [outline-color:var(--accent-primary)]!"
                        >
                            {t('knowledge.settings.duplicate_shell', 'Empty copy')}
                        </button>
                        <button
                            type="button"
                            disabled={saving}
                            onClick={() => duplicate(true)}
                            data-testid="kb-duplicate-sources"
                            className="px-3 py-1.5 rounded-lg text-xs font-medium border disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 [border-color:var(--border-subtle)] [color:var(--text-secondary)]! [outline-color:var(--accent-primary)]!"
                        >
                            {t('knowledge.settings.duplicate_sources', 'Copy with its sources')}
                        </button>
                    </div>
                    <p className="text-[11px] text-[var(--text-tertiary)]">
                        {t('knowledge.settings.duplicate_hint', 'Documents are never copied. A copied source reads its own files and pages again on its first refresh, so the copy gets what is there now.')}
                    </p>
                </section>
            )}

            {/* ── Danger zone ───────────────────────────────────── */}
            {canManage && kb?.id && (
                <DangerZone
                    entityName={kb?.name || ''}
                    usage={usage}
                    onDelete={remove}
                    kindLabel={t('usage.kind_kb', 'knowledge base')}
                    currentUserId={currentUserId}
                    onNavigate={onNavigate}
                    openLabel={t('knowledge.settings.delete_open', 'Delete this knowledge base')}
                    notice={(
                        <>
                            <p className="text-xs text-[var(--text-secondary)]">
                                {t('knowledge.settings.delete_notice', 'Its documents go with it. The original files, pages and folders they were read from stay where they are.')}
                            </p>
                            {unchecked.length > 0 && (
                                /* The list below is INCOMPLETE, and saying so
                                   is the whole point: presenting a partial
                                   answer as a complete one is how somebody
                                   deletes a base three automations were using. */
                                <p className="text-xs [color:var(--warning-ink,var(--warning))]!" data-testid="kb-delete-unchecked">
                                    {t('knowledge.settings.delete_unchecked', 'This list may be incomplete — {kinds} could not be checked.', {
                                        kinds: unchecked.map(k => t(`usage.kind_${k}_plural`, k)).join(', '),
                                    })}
                                </p>
                            )}
                        </>
                    )}
                />
            )}
        </div>
    );
}

function NameFields({ t, fieldStyle, name, description, setName, setDescription, disabled, onCommitName, onCommitDescription }: NameFieldsProps) {
    return (
        <section className="flex flex-col gap-3">
            <label className="block">
                <span className="block text-xs mb-1 font-semibold text-[var(--text-secondary)]">
                    {t('knowledge.settings.name', 'Name')}
                </span>
                <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => onCommitName(name.trim())}
                    disabled={disabled}
                    data-testid="kb-settings-name"
                    className="w-full px-3 py-2 rounded-lg text-sm border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                    style={fieldStyle}
                />
            </label>
            <label className="block">
                <span className="block text-xs mb-1 font-semibold text-[var(--text-secondary)]">
                    {t('knowledge.settings.description', 'What is in it')}
                </span>
                <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    onBlur={() => onCommitDescription(description)}
                    disabled={disabled}
                    rows={2}
                    data-testid="kb-settings-description"
                    placeholder={t('knowledge.settings.description_hint', 'A sentence an agent can read to decide whether to look here.')}
                    className="w-full px-3 py-2 rounded-lg text-sm border resize-y focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                    style={fieldStyle}
                />
            </label>
        </section>
    );
}

