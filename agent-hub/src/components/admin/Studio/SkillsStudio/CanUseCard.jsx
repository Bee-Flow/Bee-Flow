import { AppWindow, BookOpen, ChevronDown, Plus, Workflow, X } from 'lucide-react';
import React, { useRef, useState } from 'react';
import useTranslation from '../../../../hooks/useTranslation';
import { useIntegrationStatus } from '../../../../hooks/useIntegrationStatus';
import AnchoredMenu from '../../../shared/AnchoredMenu';
import Disclosure from '../../../shared/Disclosure';
import { kindColorVar } from '../../../shared/kindColors';
import { INTEGRATION_CATALOG } from '../../../agents/AgentDesigner/integrations';
import { ALWAYS_AVAILABLE, filterAvailableIntegrations } from '../../../agents/AgentDesigner/integrationAvailability';
import AppsPicker from '../../../agents/AgentWizard/pickers/AppsPicker';
import { readListStatus } from './useSkillPickerData';

/**
 * "May use" — everything a skill is allowed to reach while it is active
 * (Skills artboard 1a, right column) plus, under "All options", the two
 * switches the artboard does not draw.
 *
 * ── THREE GRANTS, ONE ROW OF PILLS ──────────────────────────────────
 *   apps        `enabled_integrations` — tools of these apps become
 *               available while the skill is active (unchanged behaviour,
 *               same catalog filter the agent builder uses, so an app the
 *               org has not connected is not offered);
 *   automations   `allowed_automation_ids` — offered as CALLABLE TOOLS, which
 *               is why only an `agent_call`-trigger automation can be picked:
 *               the runtime dispatches nothing else (S1 §5), so listing a
 *               scheduled automation here would be a promise nothing keeps;
 *   knowledge   `knowledge_base_ids` — joined into the agent's search
 *               allowlist while the skill is active.
 *
 * Ownership and activity are re-checked at dispatch time; this list is a
 * request, never an authorisation. It exists so the skill's author can SEE
 * what it reaches.
 *
 * ── WHY `dynamic_activation` IS STILL HERE ──────────────────────────
 * The artboard does not draw it. It decides whether this skill's text sits
 * in EVERY turn's prompt or only in the turns where the agent asks for it,
 * which is this switch's real subject: the prompt cost of each turn, paid
 * for the life of the agent, and a trade only the author can judge. So it
 * does not disappear — it MOVES, one disclosure down, keeping the sentence
 * it always had (`dynamic_help`). Recorded deviation from the design.
 *
 * The legacy scalar `automation_id` is explained in the same place rather
 * than removed: a skill that has one behaves completely differently (the
 * automation REPLACES the skill body), and a field with that much power must
 * not be invisible just because it is old.
 *
 * ── A LIST THAT COULD NOT BE READ IS NOT AN EMPTY LIST ──────────────
 * Every picker here draws on a read that can fail, and the failure and the
 * empty org produce the same screen unless something says otherwise. So:
 *
 *   - `listStatus` is useSkillPickerData's own answer (`loaded`, plus the
 *     `unavailable` ids). Nothing is claimed before the first answer, and a
 *     list that did not arrive is NAMED rather than shown as empty;
 *   - an integration status that is not KNOWN — failed, or not answered yet —
 *     narrows the app catalog to the platform built-ins.
 *     `filterAvailableIntegrations` treats an unknown status as "no org gate
 *     to apply", which would offer more apps than the org actually has;
 *     unknown must never widen a grant, and "not yet" is unknown;
 *   - the pills keep their "Automation {id}" fallback when the automations list is
 *     missing, and the note explains why a name is missing rather than
 *     leaving it looking deleted.
 */
export default function CanUseCard({
    enabledIntegrations,
    allowedAutomationIds,
    knowledgeBaseIds,
    dynamicActivation,
    legacyAutomationId = null,
    automations = [],
    knowledgeBases = [],
    // `{ loaded, unavailable }` — useSkillPickerData's answer about the two
    // lists below. A caller that passes literal arrays has its answer already,
    // hence the default: no gaps, and read.
    listStatus = null,
    onChange,
    readOnly = false,
}) {
    const { t } = useTranslation();
    const [showApps, setShowApps] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const anchorRef = useRef(null);

    const { integrationStatus, unavailable: appsUnavailable } = useIntegrationStatus();
    // BOTH kinds of "we do not know" narrow, not just the failed read.
    // `filterAvailableIntegrations` reads a null status as "no org gate to
    // apply" and hands back the WHOLE catalog, credential gates included — so
    // on the first navigation of a session, before /ai/user-settings has
    // answered, the picker offered apps the org has not connected. The runtime
    // refuses them later (toolStackAssembly), which leaves the author holding a
    // pill that can never work. Unknown must never widen a grant, and "not yet"
    // is unknown.
    const appsUnknown = appsUnavailable || integrationStatus === null;
    const availableApps = appsUnknown
        ? INTEGRATION_CATALOG.filter(a => ALWAYS_AVAILABLE.has(a.id))
        : filterAvailableIntegrations(INTEGRATION_CATALOG, integrationStatus);

    const { loaded: listsLoaded, unread: unreadLists, reload: reloadLists } = readListStatus(listStatus);
    // Only the two lists THIS menu offers. The hook also reads groups and
    // datatables; their gaps belong to the screens that show them.
    const menuGap = unreadLists.includes('automations') || unreadLists.includes('kbs');
    // The NOTE names reads that FAILED. A status that has not answered yet is
    // not a gap — the menu's "Loading…" line covers that moment.
    const gapNames = namesOfGaps(t, appsUnavailable, unreadLists);

    const apps = Array.isArray(enabledIntegrations) ? enabledIntegrations : [];
    const allowedIds = Array.isArray(allowedAutomationIds) ? allowedAutomationIds : [];
    const kbs = Array.isArray(knowledgeBaseIds) ? knowledgeBaseIds : [];

    const toggleIn = (field, current, id) => {
        const next = current.includes(id) ? current.filter(x => x !== id) : [...current, id];
        onChange({ [field]: next });
    };

    const nameOf = (rows, id, fallbackKey, fallbackEn) => {
        const hit = rows.find(r => String(r.id) === String(id));
        return hit?.name || hit?.title || t(fallbackKey, fallbackEn, { id }) || id;
    };

    const pickable = [
        ...automations
            .filter(a => !allowedIds.includes(String(a.id)))
            .map(a => ({ group: 'automation', id: String(a.id), label: a.title || a.name || a.id })),
        ...knowledgeBases
            .filter(k => !kbs.includes(String(k.id)))
            .map(k => ({ group: 'kb', id: String(k.id), label: k.name || k.id })),
    ];

    return (
        <section className="flex flex-col gap-2" data-testid="skill-can-use">
            <div className="flex items-center gap-2">
                <h2 className="text-[13px] font-semibold text-[var(--text-primary)] m-0">
                    {t('skills_studio.canuse.title', 'May use')}
                </h2>
                <span className="text-xs text-[var(--text-tertiary)]">
                    {t('skills_studio.canuse.hint', 'within this skill')}
                </span>
            </div>

            <div className="flex flex-wrap gap-1.5">
                {apps.map((id) => {
                    const item = INTEGRATION_CATALOG.find(a => a.id === id);
                    return (
                        <Pill
                            key={`app:${id}`}
                            testid="skill-grant"
                            kind="app"
                            Icon={AppWindow}
                            color="var(--kind-app)"
                            label={item?.label || id}
                            onRemove={readOnly ? null : () => toggleIn('enabledIntegrations', apps, id)}
                            t={t}
                        />
                    );
                })}
                {allowedIds.map((id) => (
                    <Pill
                        key={`aut:${id}`}
                        testid="skill-grant"
                        kind="automation"
                        Icon={Workflow}
                        color={kindColorVar('automation')}
                        label={nameOf(automations, id, 'skills_studio.canuse.unknown_automation', 'Automation {id}')}
                        onRemove={readOnly ? null : () => toggleIn('allowedAutomationIds', allowedIds, id)}
                        t={t}
                    />
                ))}
                {kbs.map((id) => (
                    <Pill
                        key={`kb:${id}`}
                        testid="skill-grant"
                        kind="kb"
                        Icon={BookOpen}
                        color={kindColorVar('kb')}
                        label={nameOf(knowledgeBases, id, 'skills_studio.canuse.unknown_kb', 'Knowledge base {id}')}
                        onRemove={readOnly ? null : () => toggleIn('knowledgeBaseIds', kbs, id)}
                        t={t}
                    />
                ))}

                {!readOnly && (
                    <>
                        <button
                            type="button"
                            ref={anchorRef}
                            onClick={() => setMenuOpen(o => !o)}
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            data-testid="skill-grant-add"
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border border-dashed border-[var(--border-default)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition"
                        >
                            <Plus size={12} aria-hidden="true" />
                            {t('skills_studio.canuse.link', 'link')}
                            <ChevronDown size={10} aria-hidden="true" className="opacity-60" />
                        </button>
                        <AnchoredMenu
                            open={menuOpen}
                            onClose={() => setMenuOpen(false)}
                            anchorRef={anchorRef}
                            align="left"
                            width={300}
                            maxHeight={320}
                            role="menu"
                            aria-label={t('skills_studio.canuse.link', 'link')}
                            className="py-1"
                        >
                            <button
                                type="button"
                                role="menuitem"
                                onClick={() => { setMenuOpen(false); setShowApps(true); }}
                                className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] transition"
                            >
                                <AppWindow size={13} aria-hidden="true" style={{ color: 'var(--kind-app)' }} />
                                {t('skills_studio.canuse.browse_apps', 'Browse apps…')}
                            </button>
                            <MenuStatus
                                t={t}
                                loaded={listsLoaded}
                                gap={menuGap}
                                empty={pickable.length === 0}
                            />
                            {pickable.map((row) => (
                                <button
                                    key={`${row.group}:${row.id}`}
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                        setMenuOpen(false);
                                        if (row.group === 'automation') toggleIn('allowedAutomationIds', allowedIds, row.id);
                                        else toggleIn('knowledgeBaseIds', kbs, row.id);
                                    }}
                                    className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] transition"
                                >
                                    {row.group === 'automation'
                                        ? <Workflow size={13} aria-hidden="true" style={{ color: kindColorVar('automation') }} />
                                        : <BookOpen size={13} aria-hidden="true" style={{ color: kindColorVar('kb') }} />}
                                    <span className="min-w-0 flex-1 truncate">{row.label}</span>
                                </button>
                            ))}
                        </AnchoredMenu>
                    </>
                )}
            </div>

            {/* Which reads did not come back, by name. Never a bare "something
                went wrong": a person who sees this line twice needs to be able
                to tell whether it is the same list both times. It stands
                outside the menu because it also explains a pill that shows an
                id instead of a name. */}
            {gapNames.length > 0 && (
                <p
                    className="text-[11.5px] m-0 text-[var(--warning)] flex flex-wrap items-baseline gap-x-2"
                    data-testid="skill-grant-gap"
                    // It is a statement about the state of the screen, and it
                    // appears without anybody typing — so it is announced. The
                    // agent builder's own version of this note (`UnreadableNotice`)
                    // has said so since A2.
                    role="status"
                >
                    <span>
                        {t(
                            'skills_studio.canuse.unread',
                            'Could not be read: {lists}. That is not “you have none” — what is missing is left out here rather than shown as empty.',
                            { lists: gapNames.join(', ') },
                        )}
                    </span>
                    {reloadLists && (
                        <button
                            type="button"
                            onClick={reloadLists}
                            data-testid="skill-grant-retry"
                            className="underline decoration-dotted text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition"
                        >
                            {t('skills_studio.canuse.retry', 'Try again')}
                        </button>
                    )}
                </p>
            )}

            <Disclosure
                title={t('skills_studio.options.title', 'All options')}
                className="mt-1"
            >
                <div className="flex flex-col gap-3 pt-1">
                    <label className="flex items-start gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
                        <input
                            type="checkbox"
                            checked={!!dynamicActivation}
                            disabled={readOnly}
                            onChange={(e) => onChange({ dynamicActivation: e.target.checked })}
                            data-testid="skill-dynamic"
                            className="mt-0.5"
                        />
                        <span>
                            <span className="block font-medium text-[var(--text-primary)]">
                                {t('skills_studio.field.dynamic_label', 'Dynamic activation')}
                            </span>
                            {t('skills_studio.field.dynamic_help', 'When on, the agent decides at runtime whether to apply this skill based on the user message.')}
                        </span>
                    </label>

                    {legacyAutomationId && (
                        <p className="text-xs m-0 text-[var(--text-secondary)]" data-testid="skill-legacy-automation">
                            {t(
                                'skills_studio.options.legacy_automation',
                                'This skill runs automation {id} instead of its own steps. Steps, rules and examples are ignored while that is set.',
                                { id: legacyAutomationId },
                            )}
                        </p>
                    )}
                </div>
            </Disclosure>

            {showApps && (
                <AppsPicker
                    t={t}
                    items={availableApps}
                    enabled={apps}
                    onClose={() => setShowApps(false)}
                    onToggle={(id) => toggleIn('enabledIntegrations', apps, id)}
                />
            )}
        </section>
    );
}

/**
 * What a missing list is CALLED, one branch per list rather than a
 * `{ key, en }` table: a table would put these three keys among the ones
 * that travel as DATA, and the guard only checks those in files somebody
 * remembered to register (i18nGuard's KEY_TABLE_FILES — this file is not on
 * it). Three literal t() calls are checked by default.
 *
 * No plural pair: the sentence lists names and reads the same for one name
 * or three (studio.attention.unavailable_named keeps the same rule).
 */
function namesOfGaps(t, appsUnavailable, unreadLists) {
    const names = [];
    if (appsUnavailable) names.push(t('skills_studio.canuse.gap.apps', 'apps'));
    if (unreadLists.includes('automations')) names.push(t('skills_studio.canuse.gap.automations', 'automations'));
    if (unreadLists.includes('kbs')) names.push(t('skills_studio.canuse.gap.kbs', 'knowledge bases'));
    return names;
}

/**
 * The one line in the link menu, and EXACTLY one of three. The first two are
 * the pair this menu exists to keep apart: "still asking" and "we could not
 * ask" are neither of them "you have nothing to link".
 */
function MenuStatus({ t, loaded, gap, empty }) {
    if (!loaded) {
        return (
            <p className="px-3 py-2 m-0 text-xs text-[var(--text-tertiary)]" data-testid="skill-grant-loading">
                {t('skills_studio.canuse.loading', 'Loading…')}
            </p>
        );
    }
    if (gap) {
        return (
            <p className="px-3 py-2 m-0 text-xs text-[var(--warning)]" data-testid="skill-grant-menu-gap">
                {t('skills_studio.canuse.unread_menu', 'Some of these lists could not be read, so this is not “nothing to link”.')}
            </p>
        );
    }
    if (!empty) return null;
    return (
        <p className="px-3 py-2 m-0 text-xs text-[var(--text-tertiary)]" data-testid="skill-grant-none">
            {t('skills_studio.canuse.nothing', 'Nothing else to link. An automation appears here once its trigger is “an agent calls it”.')}
        </p>
    );
}

function Pill({ testid, kind, Icon, color, label, onRemove, t }) {
    return (
        <span
            data-testid={testid}
            data-grant-kind={kind}
            className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full text-xs border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)] max-w-full"
        >
            <Icon size={12} aria-hidden="true" style={{ color }} className="flex-shrink-0" />
            <span className="truncate">{label}</span>
            {onRemove && (
                <button
                    type="button"
                    onClick={onRemove}
                    aria-label={t('skills_studio.canuse.unlink', 'Unlink {name}', { name: label })}
                    className="p-0.5 rounded-full text-[var(--text-tertiary)] hover:text-[var(--error)] transition"
                >
                    <X size={11} aria-hidden="true" />
                </button>
            )}
        </span>
    );
}
