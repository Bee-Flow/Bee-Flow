import { Building2 } from 'lucide-react';
import OrgAiContextEditor from './OrgAiContextEditor';
import OrgAiParticipationEditor from './OrgAiParticipationEditor';
import OrgCollabEditor from './OrgCollabEditor';
import useOrgSubscription from './orgInfo/license/useOrgSubscription';
import OrgAuthSection from './orgInfo/OrgAuthSection';
import OrgInfoSection from './orgInfo/OrgInfoSection';
import { Skeleton, SECTIONS } from './orgInfo/orgInfoShared';
import OrgLicenseSection from './orgInfo/OrgLicenseSection';
import useOrgInfoForm from './orgInfo/useOrgInfoForm';
import type { OrgInfoSaveState, OrgInfoUser } from './orgInfo/useOrgInfoForm';
import OrgIntegrationCacheEditor from './OrgIntegrationCacheEditor';
import OrgMemoryEditor from './OrgMemoryEditor';
import { useDeploymentMode } from '../../../hooks/useDeploymentMode';
import useProjectsAvailable from '../../../hooks/useProjectsAvailable';
import { useTranslation } from '../../../hooks/useTranslation';
import { useLicenseContext } from '../../licensing/LicenseContext';
import OrgEncryptionEditor from '../security/encryption/OrgEncryptionEditor';
import OrgShieldEditor from '../security/guardrails/orgShield/OrgShieldEditor';

interface OrgInfoPanelUser extends OrgInfoUser {
    featureFlags?: { deploymentMode?: string; projects?: boolean; [key: string]: unknown } | null;
    ncOrg?: { instanceId?: string | null; [key: string]: unknown } | null;
}

interface OrgInfoPanelProps {
    user?: OrgInfoPanelUser | null;
    activeSection?: string;
    onSave?: () => void;
    onStateChange?: (state: OrgInfoSaveState) => void;
}

/**
 * BFSF-251: jump to the org Users panel where seats are added (inviting a user
 * is what adds a billed seat on per-seat plans). Mirrors the app's own
 * back/forward routing — pushState the canonical settings URL, then fire a
 * popstate so the AdvancedSettings shell switches to the Users sub-tab.
 */
function goToUsersPanel() {
    const url = '/app/settings/organisation/users';
    try {
        if (window.location.pathname !== url) window.history.pushState({}, '', url);
        window.dispatchEvent(new PopStateEvent('popstate'));
    } catch {
        window.location.href = url;
    }
}

function NoOrganisation() {
    const { t } = useTranslation();
    return (
        <div className="flex items-center justify-center h-64">
            <div className="text-center text-[var(--text-muted)]">
                <Building2 className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p className="text-sm font-medium">{t('org.no_org')}</p>
                <p className="text-xs mt-1">{t('org.no_org_desc')}</p>
            </div>
        </div>
    );
}

const OrgInfoPanel = ({ user, activeSection, onSave: parentOnSave, onStateChange }: OrgInfoPanelProps) => {
    const { t } = useTranslation();
    const licenseCtx = useLicenseContext();
    // An org running on a licence key (e.g. a Full-tier internal org on cloud)
    // has no Stripe subscription, and must not be offered one as if it had
    // nothing: the licence page then shows neither placeholder nor plans.
    const hasActiveLicenseKey = licenseCtx?.source === 'license_key';
    // Settings that act only inside projects are shown where Projects can be used.
    const projectsOn = useProjectsAvailable(user);
    // Licence-key management belongs to the admin dashboard (Admin → Server
    // licence), never to per-org settings. The per-org License & Usage page is
    // the Stripe subscription page: on self-hosted the settings shell hides
    // it and bounces a deep link away from it.
    const { isCloud, isSelfHosted } = useDeploymentMode();
    const deploymentMode = user?.featureFlags?.deploymentMode || 'cloud';
    const ncOrg = user?.ncOrg || null;
    const isNcOrg = !!ncOrg?.instanceId;
    const { loading, saving, orgData, setOrgData, isAuthLocked, handleLogoUpload, handleLogoRemove } = useOrgInfoForm({ user, t, onSave: parentOnSave, onStateChange });
    const billing = useOrgSubscription(orgData?.id, deploymentMode, t);

    if (loading) return <Skeleton />;

    if (!orgData) return <NoOrganisation />;

    // The Privacy Shield owns its whole viewport: its own header, its own
    // scrolling pane and a save bar pinned to the bottom, so it gets a flex
    // column with a height to fill. Every other section sits in the settings
    // shell's frame as it is: the shell already scrolls and pads the content,
    // and a second scroll container or padding here would double both.
    const sectionOwnsViewport = activeSection === 'privacy';

    return (
        <div className={sectionOwnsViewport ? 'flex-1 min-h-0 flex flex-col' : undefined}>

                {/* ── License & Usage ── */}
                {activeSection === 'license' && (
                    <OrgLicenseSection
                        licenseCtx={licenseCtx}
                        hasActiveLicenseKey={hasActiveLicenseKey}
                        isCloud={isCloud}
                        deploymentMode={deploymentMode}
                        orgData={orgData}
                        setOrgData={setOrgData}
                        billing={billing}
                        goToUsersPanel={goToUsersPanel}
                    />
                )}

                {/* ── Sign-in Method ── */}
                {activeSection === 'auth' && (
                    <OrgAuthSection
                        t={t}
                        isAuthLocked={isAuthLocked}
                        isSaving={saving}
                        orgData={orgData}
                        setOrgData={setOrgData}
                        isSelfHosted={isSelfHosted}
                    />
                )}

                {/* ── Organisation Info (Branding + Legal combined) ── */}
                {activeSection === 'info' && (
                    <OrgInfoSection
                        t={t}
                        isNcOrg={isNcOrg}
                        ncOrg={ncOrg}
                        orgData={orgData}
                        setOrgData={setOrgData}
                        handleLogoUpload={handleLogoUpload}
                        handleLogoRemove={handleLogoRemove}
                    />
                )}
                {/* ── Privacy Shield ── */}
                {activeSection === 'privacy' && (
                    /* Full BLEED, not merely full width. The shield is a
                       21-column matrix, a world map and two wide tables; a
                       capped, padded, separately-scrolling column left two
                       thirds of a wide screen empty while the content inside it
                       wrapped. `min-h-0` is the half that is easy to forget —
                       without it a flex child refuses to shrink and the inner
                       scroll region never engages. */
                    <div className="animate-fadeIn flex-1 min-h-0 flex flex-col">
                        {/* orgId is required, and there is deliberately no
                            allowOrgPicker here: without an id the editor renders
                            nothing rather than falling back to orgs[0], which is
                            how this page once read and SAVED a different
                            organisation's Privacy Shield with no visible cue.
                            showActivityTab is safe HERE and only here: this
                            mount is always the session's own organisation, which
                            is the org the monitoring endpoints scope to. */}
                        <OrgShieldEditor orgId={orgData?.id} showActivityTab />
                    </div>
                )}
                {/* ── Encryption ── */}
                {activeSection === 'encryption' && (
                    /* Same orgId discipline as the Privacy Shield above: no org
                       picker, no orgs[0] fallback. Writing the wrong org's
                       encryption tier would be considerably worse than reading
                       the wrong shield. */
                    <div className="animate-fadeIn max-w-3xl">
                        {/* Own save bar, deliberately: OrgInfoPanel already
                            drives the shared one via onStateChange for the org
                            form, and two writers would clobber each other. */}
                        <OrgEncryptionEditor orgId={orgData?.id} />
                    </div>
                )}
                {/* ── Context in long conversations (compaction) and Memory ── */}
                {activeSection === 'ai_context' && (
                    /* Same orgId discipline as the two editors above: no org
                       picker and no orgs[0] fallback — this switch changes how
                       every conversation in the org is built. */
                    <div className="animate-fadeIn max-w-3xl space-y-8">
                        <OrgAiContextEditor orgId={orgData?.id} />
                        {/* Memory (what the assistant remembers about people): its own
                            switch, cap and danger zone, not to be confused with the
                            context settings above. */}
                        <OrgMemoryEditor orgId={orgData?.id} />
                        {/* Whether the AI may join team chats and comment
                            threads by itself: same orgId discipline, it
                            decides what the AI reads in every project. */}
                        <OrgAiParticipationEditor orgId={orgData?.id} enabled={projectsOn} />
                        {/* Real-time co-editing of project notebooks and pages. */}
                        <OrgCollabEditor orgId={orgData?.id} enabled={projectsOn} />
                    </div>
                )}
                {/* ── Reusing integration answers between runs ── */}
                {activeSection === 'integration_cache' && (
                    /* Same orgId discipline: this one decides whether the
                       organisation's third-party response payloads are STORED,
                       so an orgs[0] fallback would be a data decision made for
                       the wrong organisation. */
                    <div className="animate-fadeIn max-w-3xl">
                        <OrgIntegrationCacheEditor orgId={orgData?.id} />
                    </div>
                )}
        </div>
    );
};
export { SECTIONS };
export default OrgInfoPanel;
