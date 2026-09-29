import { BookOpen, Building2 } from 'lucide-react';
import React, { useMemo } from 'react';

import ActivityTab from './activity/ActivityTab';
import useShieldEvidence from './activity/useShieldEvidence';
import { derivePosture } from './orgShieldPosture';
import { buildStripItems, dirtyChips, emphasisOf } from './orgShieldStrip';
import {
    ALL_TAB_IDS, DEFAULT_TAB, TAB_IDS, isChecksTab, normaliseTab,
} from './orgShieldTabs';
import { builtInOnly } from './ownData/ownDataModel';
import OwnDataTab from './ownData/OwnDataTab';
import HowItWorksPanel from './parts/HowItWorksPanel';
import ShieldClampBanner from './parts/ShieldClampBanner';
import ShieldHeader from './parts/ShieldHeader';
import ShieldLoadError from './parts/ShieldLoadError';
import ShieldPipeline from './parts/ShieldPipeline';
import ShieldSaveBar from './parts/ShieldSaveBar';
import { SHIELD_PANE } from './shieldLayout';
import { toolGapCount } from './tabs/checks/checksModel';
import ChecksTab from './tabs/ChecksTab';
import DetectionTab from './tabs/DetectionTab';
import OverviewTab from './tabs/OverviewTab';
import useOrgShield from './useOrgShield';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { useUrlQueryParam } from '../../../../../hooks/useUrlTab';
import { useLicenseContext } from '../../../../licensing/LicenseContext';
import { toast } from '../../../../shared/Toast';

/**
 * One organisation's Privacy Shield, as an editor.
 *
 * A shell: the header (with the path strip inside it), the org picker, the
 * load-error state and the save bar. Every control lives in `tabs/`, and all state lives
 * in `useOrgShield`.
 *
 * ── Why the tab is a QUERY PARAM and not a path segment ───────────────────
 * This component is mounted twice, on two unrelated routes: the org settings
 * page (/app/settings/organisation/privacy) and the admin console
 * (/app/admin/security/guardrails/organisations). `useUrlTab` writes a PATH,
 * so a tab click in the admin console would navigate the console out of
 * itself. On the settings side it would also fight `AdvancedSettings`, which
 * pushState's its own 3-segment URL whenever the pathname differs — and
 * `useUrlTab` only re-reads on `popstate`, which pushState does not fire, so
 * the strip and the URL would silently disagree.
 *
 * A query param rides on whatever pathname is current, is invisible to both
 * route parsers, and still survives a bookmark and the back button.
 * `guardrailsRoutes.js` already writes this rule down for this very console.
 *
 * @param {string}  [orgId]          The organisation to edit. Required unless
 *   `allowOrgPicker` is set — see useOrgShield for why guessing is forbidden.
 * @param {boolean} [allowOrgPicker] Render a visible org picker and default to
 *   the first organisation. Admin view only; never in an embedded context,
 *   where a guess would be both invisible and writable.
 * @param {boolean} [readOnly]       Render every control disabled and hide Save.
 * @param {Function}[onSaved]        Called after a successful save.
 * @param {string|null} [urlParam]   Query param carrying the active tab.
 *   `null` opts out of URL sync entirely — for hosts that own the URL already.
 * @param {boolean} [showActivityTab] Offer the "What happened" monitoring tab.
 *   Default OFF, and the admin GuardrailsHub must NEVER pass it: the
 *   monitoring endpoints derive the organisation from the SESSION, so on a
 *   mount that can pin a different org the tab would silently show the wrong
 *   organisation's activity. Only the org-settings mount opts in.
 */
const OrgShieldEditor = ({ orgId = null, allowOrgPicker = false, readOnly = false, onSaved, urlParam = 'tab', showActivityTab = false }) => {
    const { t } = useTranslation();
    // 'pii_tokenize' unlocks the Tokenize action; 'web_search_guard' unlocks the
    // Web Search Guard block and external tool-call blocking. Both Enterprise —
    // the backend clamps regardless, this only avoids offering what won't stick.
    const { hasFeature: hasLicenseFeature, upgradeUrl } = useLicenseContext();
    const canTokenizePii = hasLicenseFeature('pii_tokenize');
    const canUseWebSearchGuard = hasLicenseFeature('web_search_guard');
    const canSeeActivity = hasLicenseFeature('advanced_usage_monitoring');
    // "Your own data" (Enterprise). Without it the tab shows the migrated
    // legacy terms read-only, with Remove as the only change.
    const canUseCustomData = hasLicenseFeature('custom_data_types');

    const [rawTab, setRawTab] = useUrlQueryParam(urlParam || 'tab');
    // Never trust the URL, and never NORMALISE it on mount: writing
    // `?tab=overview` on every render would litter the admin console's URL and
    // race its own replaceState. Only a click writes.
    // The valid-id set depends on the mount: `?tab=activity` on a mount that
    // does not offer the tab falls back to Overview instead of rendering a
    // wrong-organisation monitoring pane (see orgShieldTabs.ts).
    const tabIds = showActivityTab ? ALL_TAB_IDS : TAB_IDS;
    const activeTab = normaliseTab(rawTab ?? DEFAULT_TAB, tabIds);
    const [localTab, setLocalTab] = React.useState(DEFAULT_TAB);
    const tab = urlParam ? activeTab : localTab;
    const setTab = urlParam ? (id) => setRawTab(id) : setLocalTab;

    const shield = useOrgShield({ orgId, allowOrgPicker });
    const {
        loading, shieldLoading, saving, message,
        loadError, isDirty, dirtyStages, canSave, saved,
        orgList, selectedOrgId, selectOrg,
        hasEuModelsConfigured, hasWebSearchEnabled,
        guardStatus, guardCheckedAt, meta,
        categories: PII_CATEGORIES_LIST,
        save, discard, toggleToolPiiCat, setToolPiiCats, confirmDialog, fields: f,
    } = shield;

    const licence = useMemo(
        () => ({ canTokenizePii, canUseWebSearchGuard, canUseCustomData, upgradeUrl }),
        [canTokenizePii, canUseWebSearchGuard, canUseCustomData, upgradeUrl],
    );
    const env = useMemo(() => ({ hasEuModelsConfigured, hasWebSearchEnabled }), [hasEuModelsConfigured, hasWebSearchEnabled]);

    // The last 30 days in numbers, for the panes that judge a setting against
    // what actually happened (see activity/useShieldEvidence.ts). Only on the
    // mount that offers the activity pane — its endpoints read the SESSION's
    // organisation — and only on a plan that has them. `null` = unknown.
    const showActivity = showActivityTab && canSeeActivity;
    const evidence = useShieldEvidence({ enabled: showActivity });
    const egress = useMemo(() => (evidence ? {
        piiNonEuCount: evidence.piiNonEuCount,
        toolPii: toolGapCount(evidence),
        piiCategories: evidence.topToolKinds.map(id => PII_CATEGORIES_LIST.find(c => c.id === id)?.label || id),
    } : null), [evidence, PII_CATEGORIES_LIST]);

    const posture = useMemo(
        () => derivePosture(f, { categories: PII_CATEGORIES_LIST, env, licence, guard: guardStatus, egress }),
        [f, PII_CATEGORIES_LIST, env, licence, guardStatus, egress],
    );

    // Which of the org's own types the server refused on the last save. Kept
    // so the offending ROWS can be flagged: the server saves the valid types
    // and reports the rest, so a partial save used to read as a clean one.
    const [typeErrors, setTypeErrors] = React.useState([]);

    const [howItWorks, setHowItWorks] = React.useState(false);

    const handleSave = async () => {
        const result = await save();
        setTypeErrors(result.typeErrors || []);
        if (result.ok) {
            // A clamp or a rejected type means the save landed but not exactly
            // as asked. Reporting that as a plain success is how an admin ends
            // up believing a pattern is in force when it never compiled.
            if (result.clamped?.length || result.termErrors?.length || result.typeErrors?.length) {
                toast.info(t('admin.guard_saved_with_notes', 'Saved, with notes — see the message below.'));
            } else {
                toast.success(t('admin.guard_saved'));
            }
            onSaved?.();
        } else {
            toast.error(result.error || 'Failed to save.');
        }
    };

    if (loading) {
        return <div className="text-sm p-4 text-[var(--text-muted)]">{t('admin.shield_loading')}</div>;
    }

    // The path strip, each step carrying its own read-out (orgShieldStrip.ts).
    const tabItems = buildStripItems({
        f,
        total: PII_CATEGORIES_LIST.length,
        posture,
        licence,
        guard: guardStatus,
        canSeeActivity,
        showActivityTab,
        t,
    });
    // It only exists once there is a document to navigate.
    const noOrgs = !selectedOrgId && orgList.length === 0;
    const strip = noOrgs || loadError || shieldLoading ? null : (
        <ShieldPipeline
            items={tabItems}
            value={tab}
            emphasis={emphasisOf(tab)}
            onChange={setTab}
            ariaLabel={t('admin.shield_tabs_label', 'Privacy Shield sections')}
            t={t}
        />
    );

    const goToCompliance = () => {
        window.location.assign('/app/settings/organisation/compliance');
    };
    const diagnoseGuard = () => {
        // The installer lives in the platform-admin console, which an org
        // admin may not be able to open — so this is a link, not a promise,
        // and the row's hint has already said what the condition means.
        window.open('/app/admin/security/guardrails', '_blank', 'noopener');
    };

    return (
        // A full-height column: the header and the strip pin to the top, the
        // save bar to the bottom, and the pane between them scrolls. The old
        // layout let the whole page scroll, so on the category grid the Save
        // button was three screens below the thing you had just changed.
        <div className="w-full h-full flex flex-col min-h-0 animate-fadeIn">
            <ShieldHeader
                orgName={orgList.find(o => o.id === selectedOrgId)?.name}
                guard={guardStatus}
                guardCheckedAt={guardCheckedAt}
                strip={strip}
                t={t}
            >
                {/* The org picker — never shown when the org is pinned by the
                    caller: offering a choice the prop then overrides is worse
                    than offering none. */}
                {orgList.length > 1 && allowOrgPicker && !orgId && (
                    <>
                        <label htmlFor="org-shield-org" className="sr-only">{t('admin.shield_org_label')}</label>
                        <select
                            id="org-shield-org"
                            value={selectedOrgId}
                            onChange={e => selectOrg(e.target.value)}
                            className="h-[30px] px-2.5 rounded-[9px] text-xs border border-[var(--border-default)] text-[var(--text-primary)] bg-[var(--bg-card)]"
                        >
                            {orgList.map(org => (
                                <option key={org.id} value={org.id}>{org.name}</option>
                            ))}
                        </select>
                    </>
                )}
                {/* Opens IN the app. It used to be a link to docs.beeflow.nl,
                    which leaves a screen that may hold unsaved edits, is
                    unreachable on an air-gapped self-host, and described an
                    older version of this very page. */}
                <button
                    type="button"
                    onClick={() => setHowItWorks(true)}
                    className="inline-flex items-center gap-1.5 h-[30px] px-[11px] rounded-[9px] text-xs font-medium whitespace-nowrap hover:opacity-80 border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)]"
                >
                    <BookOpen className="w-[13px] h-[13px]" aria-hidden="true" />
                    {t('admin.shield_how_this_works', 'How this works')}
                </button>
            </ShieldHeader>

            {/* The empty state must not paint over a PINNED org: when the caller
                supplies an id we never fetch the org list, so it stays empty. */}
            {noOrgs ? (
                <div className="p-8 m-6 rounded-xl border text-center bg-[var(--bg-secondary)] border-[var(--border-default)]">
                    <Building2 className="w-8 h-8 mx-auto mb-3 text-[var(--text-muted)]" aria-hidden="true" />
                    <p className="text-sm text-muted">
                        {t('admin.shield_no_orgs', 'No organizations found. Create one in User Management first.')}
                    </p>
                </div>
            ) : loadError ? (
                <ShieldLoadError status={loadError.status} t={t} />
            ) : shieldLoading ? (
                <div className="text-sm text-muted py-8 text-center">{t('admin.shield_loading')}</div>
            ) : (
                <>
                    {message?.type === 'warning' && (
                        <ShieldClampBanner text={message.text} tabs={message.tabs} onGoTo={setTab} t={t} />
                    )}

                    <div
                        id="org-shield-panel"
                        role="tabpanel"
                        className="flex-1 min-h-0 overflow-y-auto px-6 py-4 [@media(max-height:780px)]:py-3"
                    >
                        {/* Capped and centred, and the container every pane
                            lays itself out against — see shieldLayout.ts. */}
                        <div className={SHIELD_PANE}>
                        {tab === 'overview' && (
                            <OverviewTab
                                f={f}
                                posture={posture}
                                guard={guardStatus}
                                meta={meta}
                                readOnly={readOnly}
                                evidence={evidence}
                                showActivity={showActivity}
                                licence={licence}
                                t={t}
                                onGoTo={setTab}
                                onDiagnoseGuard={diagnoseGuard}
                                onOpenCompliance={goToCompliance}
                            />
                        )}
                        {tab === 'detection' && (
                            <DetectionTab
                                f={f}
                                categories={PII_CATEGORIES_LIST}
                                readOnly={readOnly}
                                licence={licence}
                                evidence={evidence}
                                toggleToolPiiCat={toggleToolPiiCat}
                                setToolPiiCats={setToolPiiCats}
                                onGoTo={setTab}
                                t={t}
                            />
                        )}
                        {tab === 'owndata' && (
                            <OwnDataTab
                                f={f}
                                orgId={selectedOrgId}
                                licence={licence}
                                guard={guardStatus}
                                readOnly={readOnly}
                                typeErrors={typeErrors}
                                toggleToolPiiCat={toggleToolPiiCat}
                                setToolPiiCats={setToolPiiCats}
                                t={t}
                            />
                        )}
                        {isChecksTab(tab) && (
                            <ChecksTab
                                f={f}
                                readOnly={readOnly}
                                licence={licence}
                                env={env}
                                evidence={evidence}
                                emphasis={tab}
                                onGoTo={setTab}
                                t={t}
                            />
                        )}
                        {tab === 'activity' && showActivityTab && (
                            <ActivityTab
                                t={t}
                                shieldEnabled={!!f.enabled}
                                licensed={canSeeActivity}
                                upgradeUrl={upgradeUrl}
                                onGoTo={setTab}
                                toolHoldBack={{
                                    // The saved policy: the findings describe what produced the data.
                                    held: builtInOnly((saved || f).toolPiiPolicy?.external?.blockCategories).length,
                                    total: PII_CATEGORIES_LIST.length,
                                }}
                            />
                        )}
                        </div>
                    </div>

                    {/* The save bar belongs to the CONFIG panes; Activity is
                        read-only evidence. */}
                    {!readOnly && tab !== 'activity' && (
                        <ShieldSaveBar
                            isDirty={isDirty}
                            dirtyStages={dirtyChips(dirtyStages, t)}
                            // The amber clamp note has its own banner above the
                            // pane; repeating it down here would say the same
                            // thing twice on one screen.
                            message={message?.type === 'warning' ? null : message}
                            saving={saving}
                            canSave={canSave}
                            onSave={handleSave}
                            onDiscard={discard}
                            onGoTo={setTab}
                            t={t}
                        />
                    )}
                </>
            )}

            <HowItWorksPanel
                open={howItWorks}
                onClose={() => setHowItWorks(false)}
                guard={guardStatus}
                onGoTo={setTab}
                t={t}
            />
            {confirmDialog}
        </div>
    );
};

export default OrgShieldEditor;
