import { Building2 } from 'lucide-react';
import type { ReactNode } from 'react';
import OrgAiContextEditor from './OrgAiContextEditor';
import OrgAiParticipationEditor from './OrgAiParticipationEditor';
import OrgAutomationImageAiEditor from './OrgAutomationImageAiEditor';
import OrgCollabEditor from './OrgCollabEditor';
import useOrgSubscription from './orgInfo/license/useOrgSubscription';
import type { OrgSubscriptionState } from './orgInfo/license/useOrgSubscription';
import OrgAuthSection from './orgInfo/OrgAuthSection';
import OrgInfoSection from './orgInfo/OrgInfoSection';
import { Skeleton, SECTIONS } from './orgInfo/orgInfoShared';
import OrgLicenseSection from './orgInfo/OrgLicenseSection';
import useOrgInfoForm from './orgInfo/useOrgInfoForm';
import type { OrgInfoForm, OrgInfoSaveState, OrgInfoUser } from './orgInfo/useOrgInfoForm';
import OrgIntegrationCacheEditor from './OrgIntegrationCacheEditor';
import OrgMemoryEditor from './OrgMemoryEditor';
import { useOrgIntegrationAvailability } from '@/api/queries/orgIntegrationAvailability';
import { useDeploymentMode } from '@/hooks/useDeploymentMode';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';
import { navigate } from '@/router/history';
import { isPlatformAdmin as isPlatformAdminUser } from '@/utils/adminAccess';
import { familyAvailable } from '@/utils/integrationAvailability';
import { useLicenseContext } from '../../licensing/LicenseContext';
import OrgEncryptionEditor from '../security/encryption/OrgEncryptionEditor';
import OrgShieldEditor from '../security/guardrails/orgShield/OrgShieldEditor';

interface OrgInfoPanelUser extends OrgInfoUser {
    featureFlags?: { deploymentMode?: string; projects?: boolean; [key: string]: unknown } | null;
    isAdmin?: boolean;
}

interface OrgInfoPanelProps {
    user?: OrgInfoPanelUser | null;
    /** The organisation to edit (the admin dashboard's); left out, the user's own. */
    orgId?: string | null;
    activeSection?: string;
    onSave?: () => void;
    onStateChange?: (state: OrgInfoSaveState) => void;
}

/**
 * BFSF-251: jump to the people screen where seats are added (inviting a user
 * is what adds a billed seat on per-seat plans): the dashboard's People >
 * Invitations.
 */
const PEOPLE_INVITATIONS_PATH = '/app/admin/people/invitations';
function goToUsersPanel() {
    navigate(PEOPLE_INVITATIONS_PATH);
}

function NoOrganisation() {
    const { t } = useTranslation();
    return (
        <div className="flex items-center justify-center h-64">
            <div className="text-center text-[var(--text-muted)]">
                <Building2 className="w-12 h-12 mx-auto mb-3 opacity-30" aria-hidden="true" />
                <p className="text-sm font-medium">{t('org.no_org')}</p>
                <p className="text-xs mt-1">{t('org.no_org_desc')}</p>
            </div>
        </div>
    );
}

/** What every part of the panel may read: the CHOSEN organisation's form and facts. */
interface PartContext {
    t: TranslateFn;
    form: OrgInfoForm & { orgData: NonNullable<OrgInfoForm['orgData']> };
    billing: OrgSubscriptionState;
    licenseCtx: ReturnType<typeof useLicenseContext>;
    isCloud: boolean;
    isSelfHosted: boolean;
    deploymentMode: string;
    isPlatformAdmin: boolean;
    /** The chosen organisation can use Projects (its availability, not the viewer's own plan). */
    projectsOn: boolean;
}

/**
 * The parts of the panel, one per section id (orgInfoShared SECTIONS). The
 * admin dashboard mounts most of them as rows of their own (Organisation info,
 * Licence & usage, Preferred sign-in method; the editors directly); a phone's
 * Settings > Organisation still reaches each one here. The page header is the
 * frame's (AdminPage), so no part draws a page title or a width of its own.
 * Each part saves through its own editor except the three form rows (info,
 * auth, license), whose save bar is OrganisationSection's.
 */
const PARTS: Readonly<Record<string, (c: PartContext) => ReactNode>> = {
    license: (c) => (
        <OrgLicenseSection
            licenseCtx={c.licenseCtx}
            // An org on a licence key has no Stripe subscription and is not offered one.
            hasActiveLicenseKey={c.licenseCtx?.source === 'license_key'}
            isCloud={c.isCloud}
            deploymentMode={c.deploymentMode}
            orgData={c.form.orgData}
            setOrgData={c.form.setOrgData}
            billing={c.billing}
            goToUsersPanel={goToUsersPanel}
        />
    ),
    auth: (c) => <OrgAuthSection t={c.t} orgData={c.form.orgData} setOrgData={c.form.setOrgData} isSelfHosted={c.isSelfHosted} />,
    info: (c) => (
        <OrgInfoSection
            t={c.t}
            isCloud={c.isCloud}
            orgData={c.form.orgData}
            setOrgData={c.form.setOrgData}
            handleLogoUpload={c.form.handleLogoUpload}
            handleLogoRemove={c.form.handleLogoRemove}
            isPlatformAdmin={c.isPlatformAdmin}
        />
    ),
    // The Privacy Shield owns its viewport (its own scrolling pane and pinned
    // save bar): full bleed, and `min-h-0` so the inner scroll region engages.
    // orgId is required and there is no org picker: without an id the editor
    // renders nothing rather than another organisation's shield.
    // showActivityTab is safe here: the monitoring endpoints scope to this org.
    privacy: (c) => (
        <div className="animate-fadeIn flex-1 min-h-0 flex flex-col">
            <OrgShieldEditor orgId={c.form.orgData.id} showActivityTab />
        </div>
    ),
    // Same orgId discipline (no picker, no orgs[0] fallback), and its own save
    // bar: OrgInfoPanel drives the shared one for the org form.
    encryption: (c) => (
        <div className="animate-fadeIn">
            <OrgEncryptionEditor orgId={c.form.orgData.id} />
        </div>
    ),
    // The four editors the dashboard shows as Conversations, Memory and
    // Projects; on a phone they stay one page.
    ai_context: (c) => (
        <div className="animate-fadeIn space-y-8">
            <OrgAiContextEditor orgId={c.form.orgData.id} />
            <OrgMemoryEditor orgId={c.form.orgData.id} />
            <OrgAiParticipationEditor orgId={c.form.orgData.id} enabled={c.projectsOn} />
            <OrgCollabEditor orgId={c.form.orgData.id} enabled={c.projectsOn} />
        </div>
    ),
    // The organisation's automation policies, one page (the dashboard's
    // Automations row): whether third-party response payloads are STORED
    // between runs, and whether an automation may show a picture itself to an
    // AI model. Both decide what leaves or stays in the organisation: the same
    // orgId discipline.
    integration_cache: (c) => (
        <div className="animate-fadeIn space-y-8">
            <OrgIntegrationCacheEditor orgId={c.form.orgData.id} />
            <OrgAutomationImageAiEditor orgId={c.form.orgData.id} />
        </div>
    ),
};

const OrgInfoPanel = ({ user, orgId, activeSection, onSave: parentOnSave, onStateChange }: OrgInfoPanelProps) => {
    const { t } = useTranslation();
    const licenseCtx = useLicenseContext();
    // Licence-key management belongs to the admin dashboard (the server
    // licence row), never to per-org settings: the per-org licence page is the
    // Stripe subscription page.
    const { isCloud, isSelfHosted } = useDeploymentMode();
    const deploymentMode = user?.featureFlags?.deploymentMode || 'cloud';
    const isPlatformAdmin = isPlatformAdminUser(user);
    // section: each row saves (and calls unsaved) only its own fields.
    const form = useOrgInfoForm({ user, orgId, section: activeSection, t, onSave: parentOnSave, onStateChange });
    const billing = useOrgSubscription(form.orgData?.id, deploymentMode, t);
    // What the CHOSEN organisation can use, from its availability: a platform
    // admin working on another organisation gets that organisation's answer.
    const availability = useOrgIntegrationAvailability(form.orgData?.id, activeSection === 'ai_context');
    const projectsOn = familyAvailable(availability, 'projects', { platformAdmin: isPlatformAdmin }).available;

    if (form.loading) return <Skeleton />;
    const { orgData } = form;
    if (!orgData) return <NoOrganisation />;

    const part = activeSection && Object.hasOwn(PARTS, activeSection) ? PARTS[activeSection] : null;
    if (!part) return null;
    const ctx: PartContext = { t, form: { ...form, orgData }, billing, licenseCtx, isCloud, isSelfHosted, deploymentMode, isPlatformAdmin, projectsOn };
    return (
        <div className={activeSection === 'privacy' ? 'flex-1 min-h-0 flex flex-col' : undefined}>
            {part(ctx)}
        </div>
    );
};
export { SECTIONS };
export default OrgInfoPanel;
