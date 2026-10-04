import { Bot, Building2, MessageSquare, Workflow } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { knowledgeApi } from './knowledgeApi';
import useTranslation from '../../../../hooks/useTranslation';
import CategoryField from '../../../agents/AgentWizard/CategoryField';
import AudienceRows from '../../../shared/AudienceRows';
import DangerZone from '../../../shared/DangerZone';
import { kindColorVar } from '../../../shared/kindColors';

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

/** The three surfaces the Studio offers. 'webpage' stays hidden — auto-created bases own it. */
export const SURFACE_CARDS = Object.freeze([
    { id: 'agent', Icon: Bot, kind: 'agent' },
    { id: 'direct_chat', Icon: MessageSquare, kind: 'chat' },
    { id: 'ai_step', Icon: Workflow, kind: 'automation' },
]);

/**
 * A base's surfaces, with the one rule that matters: a value that was never
 * expressed means EVERYWHERE, not nowhere. A NULL predates the column, and a
 * settings screen that drew every box unticked would invite somebody to
 * "fix" it by ticking one — silently removing the base from the other two.
 */
export function surfacesOf(kb) {
    const raw = kb?.usage_contexts ?? kb?.usageContexts;
    if (raw === null || raw === undefined) return SURFACE_CARDS.map(c => c.id);
    let list = raw;
    if (typeof raw === 'string') {
        try { list = JSON.parse(raw); } catch { return SURFACE_CARDS.map(c => c.id); }
    }
    if (!Array.isArray(list)) return SURFACE_CARDS.map(c => c.id);
    return list.filter(v => typeof v === 'string');
}

/** How many things in the Used-by list depend on this base through `surface`. */
export function attachedCount(usage, surface) {
    if (!Array.isArray(usage)) return 0;
    const roles = surface === 'ai_step' ? ['ai_step'] : surface === 'agent' ? ['chat'] : [];
    if (roles.length === 0) return 0;
    const kinds = surface === 'ai_step' ? ['automation', 'app'] : ['agent', 'webpage', 'support'];
    return usage.filter(u => roles.includes(u.role) && kinds.includes(u.kind)).length;
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
}) {
    const { t } = useTranslation();
    const [name, setName] = useState(kb?.name || '');
    const [description, setDescription] = useState(kb?.description || '');
    const [categories, setCategories] = useState([]);
    const [error, setError] = useState(null);
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

    const save = useCallback(async (patch) => {
        if (!kb?.id) return;
        setSaving(true);
        setError(null);
        try {
            await knowledgeApi.update(kb.id, patch);
            await onSaved?.();
        } catch (e) {
            setError(e?.message || t('knowledge.settings.err_save', 'Could not save that change.'));
        } finally {
            setSaving(false);
        }
    }, [kb?.id, onSaved, t]);

    const toggleSurface = useCallback((surface) => {
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

    const setAudience = useCallback(async (body) => {
        if (!kb?.id) return;
        setError(null);
        try {
            await knowledgeApi.setPublished(kb.id, body);
            await onSaved?.();
        } catch (e) {
            setError(e?.message || t('knowledge.settings.err_save', 'Could not save that change.'));
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
    const duplicate = useCallback(async (withSources) => {
        if (!kb?.id) return;
        setSaving(true);
        setError(null);
        try {
            const copy = await knowledgeApi.duplicate(kb.id, { withSources });
            await onDuplicated?.(copy);
        } catch (e) {
            setError(e?.message || t('knowledge.settings.err_duplicate', 'Could not duplicate this knowledge base.'));
        } finally {
            setSaving(false);
        }
    }, [kb?.id, onDuplicated, t]);

    const remove = useCallback(async (confirmedBreaking) => {
        const body = await knowledgeApi.remove(kb.id, { confirm: confirmedBreaking });
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
                <p className="text-xs" role="alert" style={{ color: 'var(--error)' }}>{error}</p>
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
            <section className="flex flex-col gap-2" data-testid="kb-surfaces">
                <h3 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {t('knowledge.settings.where_title', 'Where it can be used')}
                </h3>
                <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
                    {SURFACE_CARDS.map(({ id }) => (
                        <SurfaceCard
                            key={id}
                            id={id}
                            active={surfaces.includes(id)}
                            disabled={!canManage || saving}
                            attached={attachedCount(usage, id)}
                            onToggle={() => toggleSurface(id)}
                            t={t}
                        />
                    ))}
                </div>
                <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                    {t('knowledge.settings.where_hint', 'This decides which pickers offer this knowledge base. It does not change who may read what is in it — that is below.')}
                </p>
            </section>

            {/* ── Who may see it ────────────────────────────────── */}
            <section className="flex flex-col gap-2" data-testid="kb-audience">
                {isPersonal ? (
                    <PersonalNotice
                        t={t}
                        canMove={canManage && !!orgId}
                        onMove={moveToOrg}
                        busy={saving}
                    />
                ) : (
                    <AudienceRows
                        agent={kb}
                        isPublished={view.isPublished}
                        sharedGroups={view.sharedGroups}
                        orgGroups={orgGroups}
                        disabled={!canManage}
                        confirmWidening
                        title={t('knowledge.settings.who_title', 'Who may see and use it')}
                        hint={t('knowledge.settings.who_hint', 'An agent can only answer from this knowledge base for someone who may see it. Everyone else gets the same answer with this left out — never an error.')}
                        onSetPersonal={() => setAudience({ isPublished: false, sharedGroups: [] })}
                        onSetEntireOrg={() => setAudience({ isPublished: true, sharedGroups: [] })}
                        onToggleGroup={(gid) => {
                            const cur = view.sharedGroups;
                            const next = cur.includes(gid) ? cur.filter(g => g !== gid) : [...cur, gid];
                            return setAudience({ isPublished: true, sharedGroups: next });
                        }}
                    />
                )}
            </section>

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
                    <h3 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {t('knowledge.settings.duplicate_title', 'Make a copy')}
                    </h3>
                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            disabled={saving}
                            onClick={() => duplicate(false)}
                            data-testid="kb-duplicate-shell"
                            className="px-3 py-1.5 rounded-lg text-xs font-medium border disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}
                        >
                            {t('knowledge.settings.duplicate_shell', 'Empty copy')}
                        </button>
                        <button
                            type="button"
                            disabled={saving}
                            onClick={() => duplicate(true)}
                            data-testid="kb-duplicate-sources"
                            className="px-3 py-1.5 rounded-lg text-xs font-medium border disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}
                        >
                            {t('knowledge.settings.duplicate_sources', 'Copy with its sources')}
                        </button>
                    </div>
                    <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
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
                            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                {t('knowledge.settings.delete_notice', 'Its documents go with it. The original files, pages and folders they were read from stay where they are.')}
                            </p>
                            {unchecked.length > 0 && (
                                /* The list below is INCOMPLETE, and saying so
                                   is the whole point: presenting a partial
                                   answer as a complete one is how somebody
                                   deletes a base three automations were using. */
                                <p className="text-xs" data-testid="kb-delete-unchecked" style={{ color: 'var(--warning-ink, var(--warning))' }}>
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

/** Name and description. Both commit on blur — a PATCH per keystroke is a PATCH per keystroke. */
function NameFields({ t, fieldStyle, name, description, setName, setDescription, disabled, onCommitName, onCommitDescription }) {
    return (
        <section className="flex flex-col gap-3">
            <label className="block">
                <span className="block text-xs mb-1 font-semibold" style={{ color: 'var(--text-secondary)' }}>
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
                <span className="block text-xs mb-1 font-semibold" style={{ color: 'var(--text-secondary)' }}>
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

/**
 * One surface toggle. Active is the artboard's 2px ink border, drawn the way
 * AudienceRows draws it (1px border + 1px inset ring) so ticking one does not
 * shift the row by a pixel.
 */
function SurfaceCard({ id, active, disabled, attached, onToggle, t }) {
    const card = SURFACE_CARDS.find(c => c.id === id) || SURFACE_CARDS[0];
    const Glyph = card.Icon;
    const colour = kindColorVar(card.kind);
    const LABELS = {
        agent: t('knowledge.settings.surface_agent', 'Agents'),
        direct_chat: t('knowledge.settings.surface_direct_chat', 'Chat'),
        ai_step: t('knowledge.settings.surface_ai_step', 'Automations'),
    };
    return (
        <button
            type="button"
            role="switch"
            aria-checked={active}
            aria-label={LABELS[id]}
            disabled={disabled}
            onClick={onToggle}
            data-testid={`kb-surface-${id}`}
            data-active={active ? 'true' : 'false'}
            className="flex flex-col items-start gap-1 p-2.5 rounded-[10px] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60"
            style={{
                border: `1px solid ${active ? 'var(--text-primary)' : 'var(--border-default)'}`,
                boxShadow: active ? 'inset 0 0 0 1px var(--text-primary)' : 'none',
                background: 'var(--bg-card)',
                outlineColor: 'var(--accent-primary)',
            }}
        >
            <Glyph style={{ width: 14, height: 14, color: colour }} aria-hidden="true" />
            <span
                className="text-[12px]"
                style={{ color: 'var(--text-primary)', fontWeight: active ? 600 : 400 }}
            >
                {LABELS[id]}
            </span>
            {/* Unticking a surface never detaches what is already attached —
                the server only refuses NEW links — so the count says so
                rather than letting somebody think they revoked something. */}
            {!active && attached > 0 && (
                <span className="text-[10px]" style={{ color: 'var(--warning-ink, var(--warning))' }}>
                    {attached === 1
                        ? t('knowledge.settings.still_attached_one', 'still attached to 1')
                        : t('knowledge.settings.still_attached', 'still attached to {n}', { n: attached })}
                </span>
            )}
        </button>
    );
}

/**
 * A base with no organisation cannot be shared at all: publishing refuses it,
 * and every non-owner is turned away before the published flag is even read.
 * Until K5 there was no way out of that state — the only way to share such a
 * base was to build it again inside an organisation.
 */
function PersonalNotice({ t, canMove, onMove, busy }) {
    return (
        <div
            className="flex flex-col gap-2 p-3 rounded-[10px]"
            style={{ border: '1px solid var(--border-default)', background: 'var(--bg-card)' }}
            data-testid="kb-personal-notice"
        >
            <div className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                <Building2 style={{ width: 14, height: 14 }} aria-hidden="true" />
                {t('knowledge.settings.personal_title', 'Personal — only you can see this')}
            </div>
            <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                {t('knowledge.settings.personal_hint', 'A personal knowledge base cannot be shared. Move it into your organisation to choose an audience.')}
            </p>
            {canMove && (
                <button
                    type="button"
                    onClick={onMove}
                    disabled={busy}
                    data-testid="kb-move-to-org"
                    className="self-start px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{
                        background: 'var(--accent-primary)',
                        color: 'var(--accent-primary-fg)',
                        outlineColor: 'var(--accent-primary)',
                    }}
                >
                    {t('knowledge.settings.move_to_org', 'Move to my organisation')}
                </button>
            )}
            {canMove && (
                <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                    {/* The consequence, before the button rather than after it. */}
                    {t('knowledge.settings.move_consequence', 'It stays unshared until you pick an audience — but administrators will be able to see and manage it, and this cannot be undone.')}
                </p>
            )}
        </div>
    );
}
