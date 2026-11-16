import type { Dispatch, SetStateAction } from 'react';
import { ArrowRight, RotateCcw } from 'lucide-react';
import type { TranslateFn } from '@/hooks/useTranslation';
import { API_BASE } from '@/utils/helpers';
import Modal from '@/components/shared/Modal';
import { Button } from '@/components/shared/Button';
import { buttonClass } from '@/components/shared/buttonClasses';
import { ALERT_INFO, CHIP } from '@/components/shared/adminUi';
import { INTEGRATION_CATALOG } from '@/config/integrationCatalog';
import { useAdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import { useShellProps } from '@/authedApp/useShellProps';
import type { AdminGroup, OrgFormData } from './types';

/** Where an organisation's integrations are chosen now: Access > Ceiling > Organisation access. */
const ACCESS_CEILING_PATH = 'admin/access/ceiling';

const FIELD = 'w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]';

/** A catalogue integration's name, or its id when the catalogue does not know it. */
function integrationLabel(id: string): string {
    return INTEGRATION_CATALOG.find(i => i.id === id)?.label ?? id;
}

interface LegacyIntegrationsProps {
    orgId: string | undefined;
    list: string[] | null | undefined;
    onReset: () => void;
    onClose: () => void;
    t: TranslateFn;
}

/**
 * The organisation's old "Enabled integrations" list, read-only. Which
 * integrations an organisation may use is chosen under Access > Ceiling
 * (Organisation access); this older list is still enforced on top of it until
 * the two are folded into one on the server, so an organisation limited by it
 * shows the limit here and can be handed back to Access by dropping the list
 * (null, saved with the form; the server then reads the Defaults for new
 * organisations, as for any organisation without a list of its own).
 */
function LegacyIntegrations({ orgId, list, onReset, onClose, t }: LegacyIntegrationsProps) {
    const choice = useAdminOrgChoice();
    const { onNavigate } = useShellProps({});
    const openAccess = () => {
        if (orgId) choice?.setOrgId(orgId);
        onNavigate?.(ACCESS_CEILING_PATH);
        onClose();
    };
    const limited = Array.isArray(list);
    return (
        <div data-testid="org-modal-integrations">
            <label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.org_modal_integrations', 'Enabled Integrations')}</label>
            <p className="text-xs mb-2 text-[var(--text-muted)]">
                {t('admin_platform.org_modal_integrations_hint', 'Which integrations this organisation may use is chosen under Access › Ceiling. An older list kept on the organisation can still narrow that choice.')}
            </p>
            <div className={`${ALERT_INFO} flex-col`}>
                {limited ? (
                    <>
                        <p className="m-0">{list.length === 1
                            ? t('admin_platform.org_modal_integrations_limited_one', 'Limited by the older list to 1 integration:')
                            : t('admin_platform.org_modal_integrations_limited', 'Limited by the older list to {count} integrations:', { count: list.length })}</p>
                        <div className="flex flex-wrap gap-1.5">
                            {list.length === 0
                                ? <span className={CHIP}>{t('admin_platform.org_modal_integrations_none', 'None')}</span>
                                : list.map(id => <span key={id} className={CHIP}>{integrationLabel(id)}</span>)}
                        </div>
                    </>
                ) : (
                    // Without a list of its own the server falls back to the Defaults for new organisations (resolveOrgAllowList), not to "all".
                    <p className="m-0">{t('admin_platform.org_modal_integrations_all', "No older list: the organisation follows this server's Defaults for new organisations, within what Access allows it.")}</p>
                )}
                <div className="flex flex-wrap gap-2 pt-1">
                    {limited ? (
                        <Button variant="secondary" size="sm" icon={RotateCcw} onClick={onReset} data-testid="org-modal-integrations-reset">
                            {t('admin_platform.org_modal_integrations_reset', 'Drop the older list')}
                        </Button>
                    ) : null}
                    {onNavigate ? (
                        <Button variant="ghost" size="sm" iconRight={<ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />} onClick={openAccess}>
                            {t('admin_platform.org_modal_integrations_manage', 'Choose in Access › Ceiling')}
                        </Button>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

export interface OrganizationModalProps {
    open: boolean;
    onClose: () => void;
    showEditOrg: boolean;
    orgData: OrgFormData;
    setOrgData: Dispatch<SetStateAction<OrgFormData>>;
    groups: AdminGroup[];
    isFullAdmin: boolean | undefined;
    onSubmitAdd: () => void;
    onSubmitUpdate: () => void;
    onUploadLogo: (file: File) => void;
    onRemoveLogo: () => void;
    t: TranslateFn;
}

export default function OrganizationModal({
    open, onClose, showEditOrg, orgData, setOrgData, groups, isFullAdmin, onSubmitAdd, onSubmitUpdate, onUploadLogo, onRemoveLogo, t,
}: OrganizationModalProps) {
    return (
        <Modal
            open={open}
            onClose={onClose}
            title={showEditOrg ? t('admin.sec_org_edit_title', 'Edit organisation') : t('admin.sec_org_add_title', 'Add new organisation')}
            size="lg"
            footer={
                <>
                    <Button variant="ghost" onClick={onClose}>
                        {t('admin.sec_cancel', 'Cancel')}
                    </Button>
                    <Button variant="primary" onClick={showEditOrg ? onSubmitUpdate : onSubmitAdd}>
                        {showEditOrg ? t('admin.sec_save', 'Save') : t('admin.sec_org_add_submit', 'Add organisation')}
                    </Button>
                </>
            }
        >
            <div className="space-y-4">
                {/* Company Logo */}
                <div>
                    <label className="block text-sm font-medium mb-2 text-[var(--text-primary)]">{t('admin_org.org_modal_logo', 'Company Logo')}</label>
                    <div className="flex items-center gap-4">
                        {orgData.logo && (
                            <img src={orgData.logo.startsWith('/') ? `${API_BASE}${orgData.logo}` : orgData.logo} alt={t('admin_org.org_modal_logo_alt', 'Logo')} className="w-16 h-16 object-contain rounded-lg border border-[var(--border-default)]" />
                        )}
                        <div className="flex items-center gap-2">
                            <label className={`cursor-pointer ${buttonClass('secondary', 'md')}`}>
                                {t('admin_org.org_modal_upload_logo', 'Upload Logo')}
                                <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="hidden" onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    if (file) onUploadLogo(file);
                                }} />
                            </label>
                            {orgData.logo && (
                                <Button variant="ghost" size="sm" onClick={onRemoveLogo}>{t('admin_org.org_modal_remove', 'Remove')}</Button>
                            )}
                        </div>
                    </div>
                    <p className="text-xs mt-1 text-[var(--text-muted)]">{t('admin_org.org_modal_logo_hint', 'Recommended: PNG or SVG, max 500x200px')}</p>
                </div>
                <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.org_modal_company_name', 'Company Name')}</label><input type="text" value={orgData.name} onChange={e => setOrgData(p => ({ ...p, name: e.target.value }))} className={FIELD} placeholder={t('admin_platform.org_modal_name_ph', 'Company name')} /></div>
                <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.org_modal_tagline', 'Company Details / Tagline')}</label><input type="text" value={orgData.tagline} onChange={e => setOrgData(p => ({ ...p, tagline: e.target.value }))} className={FIELD} placeholder={t('admin_platform.org_modal_tagline_ph', 'A short line about the organisation')} /></div>
                <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.org_modal_description', 'Description')}</label><input type="text" value={orgData.description} onChange={e => setOrgData(p => ({ ...p, description: e.target.value }))} className={FIELD} placeholder={t('admin_platform.org_modal_desc_ph', 'What this organisation is for')} /></div>
                <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.org_modal_address', 'Address')}</label><input type="text" value={orgData.address} onChange={e => setOrgData(p => ({ ...p, address: e.target.value }))} className={FIELD} placeholder={t('admin_platform.org_modal_address_ph', 'Street and number, postcode and city')} /></div>
                <div className="grid grid-cols-2 gap-4">
                    <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.org_modal_email', 'Email')}</label><input type="email" value={orgData.email} onChange={e => setOrgData(p => ({ ...p, email: e.target.value }))} className={FIELD} placeholder="info@example.com" /></div>
                    <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.org_modal_phone', 'Phone')}</label><input type="tel" value={orgData.phone} onChange={e => setOrgData(p => ({ ...p, phone: e.target.value }))} className={FIELD} placeholder="+1 555 123 4567" /></div>
                </div>
                <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.org_modal_website', 'Website')}</label><input type="url" value={orgData.website} onChange={e => setOrgData(p => ({ ...p, website: e.target.value }))} className={FIELD} placeholder="www.example.com" /></div>
                <div className="grid grid-cols-2 gap-4">
                    <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.org_modal_kvk', 'Chamber of Commerce')}</label><input type="text" value={orgData.kvk} onChange={e => setOrgData(p => ({ ...p, kvk: e.target.value }))} className={FIELD} placeholder="12345678" /></div>
                    <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.org_modal_vat', 'VAT Number')}</label><input type="text" value={orgData.vat} onChange={e => setOrgData(p => ({ ...p, vat: e.target.value }))} className={FIELD} placeholder={t('admin_org.org_modal_vat_ph', 'XX123456789')} /></div>
                </div>
                <div>
                    <label className="flex items-center gap-3 cursor-pointer p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)]">
                        <input type="checkbox" checked={orgData.allowSignup || false} onChange={e => setOrgData(p => ({ ...p, allowSignup: e.target.checked }))} className="accent-[var(--accent-primary)] w-4 h-4" />
                        <div>
                            <span className="text-sm font-medium block text-[var(--text-primary)]">{t('admin_org.org_modal_signup', 'Allow Public Signup')}</span>
                            <span className="text-xs text-[var(--text-muted)]">{t('admin_org.org_modal_signup_hint', 'Users can register themselves for this organization')}</span>
                        </div>
                    </label>
                </div>
                <div>
                    <label className="block text-sm font-medium mb-2 text-[var(--text-primary)]">{t('admin_org.org_modal_default_groups', 'Default Groups')}</label>
                    <p className="text-xs mb-2 text-[var(--text-muted)]">{t('admin_org.org_modal_default_groups_hint', 'New users will be automatically assigned to these groups')}</p>
                    <div className="max-h-40 overflow-auto p-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)]">
                        {groups.filter(g => !g.organizationId || g.organizationId === orgData.id).map(g => (
                            <label key={g.id} className="flex items-center gap-2.5 cursor-pointer px-2 py-1.5 rounded-lg hover:bg-[var(--item-hover-bg)] transition-colors">
                                <input type="checkbox" checked={(orgData.defaultGroups || []).includes(g.id)} onChange={e => setOrgData(prev => ({ ...prev, defaultGroups: e.target.checked ? [...(prev.defaultGroups || []), g.id] : (prev.defaultGroups || []).filter(x => x !== g.id) }))} className="accent-[var(--accent-primary)] w-4 h-4" />
                                <div className="flex-1 min-w-0">
                                    <span className="text-sm font-medium block text-[var(--text-primary)]">{g.name}</span>
                                    {g.description && <span className="text-xs text-[var(--text-muted)]">{g.description}</span>}
                                </div>
                            </label>
                        ))}
                        {groups.length === 0 && <p className="text-sm px-2 py-1 text-[var(--text-muted)]">{t('admin_org.org_modal_no_groups', 'No groups available. Create groups first.')}</p>}
                    </div>
                </div>
                {/* The older per-organisation integrations list (Super Admin only), read-only. */}
                {isFullAdmin && showEditOrg && (
                    <LegacyIntegrations
                        orgId={orgData.id}
                        list={orgData.enabledIntegrations}
                        onReset={() => setOrgData(p => ({ ...p, enabledIntegrations: null }))}
                        onClose={onClose}
                        t={t}
                    />
                )}
            </div>
        </Modal>
    );
}
