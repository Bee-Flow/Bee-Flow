import { useState } from 'react';
import { useOrgIntegrationAvailability } from '@/api/queries/orgIntegrationAvailability';
import { useAdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import { ALERT_ERROR, ALERT_INFO } from '@/components/shared/adminUi';
import SaveFooter from '@/components/shared/SaveFooter';
import { useTranslation } from '@/hooks/useTranslation';
import { availabilityUnknownText, familyAvailable } from '@/utils/integrationAvailability';
import useOrgInfoForm, { type OrgInfoSaveState } from '../orgInfo/useOrgInfoForm';
import OrgImageLimitsCard from './OrgImageLimitsCard';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const IDLE: OrgInfoSaveState = { hasChanges: false, saving: false, message: null, handleSave: async () => {} };

/** The card with its own save: the organisation form's image-limits row (useOrgInfoForm 'image-limits'). */
function ImageLimitsForm({ orgId }: { orgId: string }) {
    const { t } = useTranslation();
    const [bar, setBar] = useState<OrgInfoSaveState>(IDLE);
    const { loading, orgData, setOrgData } = useOrgInfoForm({ user: null, orgId, section: 'image-limits', t, onStateChange: setBar });
    if (loading || !orgData) return null;
    const saveState: SaveState = bar.saving ? 'saving' : bar.message?.type === 'error' ? 'error' : bar.message?.type === 'success' ? 'saved' : 'idle';
    return (
        <div className="space-y-3" data-testid="org-image-limits">
            <OrgImageLimitsCard orgData={orgData} setOrgData={setOrgData} />
            {bar.message?.type === 'error' && <p role="alert" className={ALERT_ERROR}>{bar.message.text}</p>}
            <SaveFooter
                onSave={() => { void bar.handleSave(); }}
                saving={bar.saving}
                dirty={bar.hasChanges}
                saveState={saveState}
            />
        </div>
    );
}

interface OrgImageLimitsSectionProps {
    /** The organisation the Models page works on (the dashboard's chosen one). */
    orgId: string;
}

/**
 * The organisation's default image limits per user, on the Models page (an AI
 * usage limit, in one place on cloud and self-hosted alike). Shown only when
 * the CHOSEN organisation can generate images (availability family
 * `imageGen`): with no image model there is nothing to limit. A platform
 * admin whose answer could not be read still gets the card, with a note.
 */
export default function OrgImageLimitsSection({ orgId }: OrgImageLimitsSectionProps) {
    const { t } = useTranslation();
    const platformAdmin = useAdminOrgChoice()?.isPlatformAdmin ?? false;
    const read = useOrgIntegrationAvailability(orgId);
    if (read.isLoading) return null;
    const verdict = familyAvailable(read, 'imageGen', { platformAdmin });
    if (!verdict.available) return null;
    return (
        <div className="space-y-3">
            {verdict.unknown && <p className={ALERT_INFO}>{availabilityUnknownText(t)}</p>}
            <ImageLimitsForm key={orgId} orgId={orgId} />
        </div>
    );
}
