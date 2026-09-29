import type { Dispatch, SetStateAction } from 'react';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import { API_BASE } from '../../../../utils/helpers';
import Modal from '../../../shared/Modal';
import { ALL_INTEGRATIONS } from './constants';
import type { AdminGroup, OrgFormData } from './types';

export interface OrganizationModalProps {
    open: boolean;
    onClose: () => void;
    showEditOrg: boolean;
    orgData: OrgFormData;
    setOrgData: Dispatch<SetStateAction<OrgFormData>>;
    groups: AdminGroup[];
    isFullAdmin: boolean;
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
                    <button onClick={onClose} className="px-4 py-2 rounded-lg font-medium text-[var(--text-secondary)]">
                        {t('admin.sec_cancel', 'Cancel')}
                    </button>
                    <button
                        onClick={showEditOrg ? onSubmitUpdate : onSubmitAdd}
                        className="px-4 py-2 rounded-lg font-medium bg-[var(--accent-primary)] text-white"
                    >
                        {showEditOrg ? t('admin.sec_save', 'Save') : t('admin.sec_org_add_submit', 'Add organisation')}
                    </button>
                </>
            }
        >
            <div className="space-y-4">
                {/* Company Logo */}
                <div>
                    <label className="block text-sm font-medium mb-2 text-[var(--text-primary)]">Company Logo</label>
                    <div className="flex items-center gap-4">
                        {orgData.logo && (
                            <img src={orgData.logo.startsWith('/') ? `${API_BASE}${orgData.logo}` : orgData.logo} alt="Logo" className="w-16 h-16 object-contain rounded-lg border border-[var(--border-default)]" />
                        )}
                        <div className="flex items-center gap-2">
                            <label className="cursor-pointer px-4 py-2 rounded-lg font-medium text-sm bg-[var(--accent-primary)] text-white">
                                Upload Logo
                                <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="hidden" onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    if (file) onUploadLogo(file);
                                }} />
                            </label>
                            {orgData.logo && (
                                <button onClick={onRemoveLogo} className="text-sm font-medium text-[var(--text-muted)]">Remove</button>
                            )}
                        </div>
                    </div>
                    <p className="text-xs mt-1 text-[var(--text-muted)]">Recommended: PNG or SVG, max 500x200px</p>
                </div>
                <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">Company Name</label><input type="text" value={orgData.name} onChange={e => setOrgData(p => ({ ...p, name: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" placeholder="Bee Flow B.V." /></div>
                <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">Company Details / Tagline</label><input type="text" value={orgData.tagline} onChange={e => setOrgData(p => ({ ...p, tagline: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" placeholder="Intelligence in Action. Results That Stick" /></div>
                <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">Description</label><input type="text" value={orgData.description} onChange={e => setOrgData(p => ({ ...p, description: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" placeholder="Main organization" /></div>
                <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">Address</label><input type="text" value={orgData.address} onChange={e => setOrgData(p => ({ ...p, address: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" placeholder="123 Main Street" /></div>
                <div className="grid grid-cols-2 gap-4">
                    <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">Email</label><input type="email" value={orgData.email} onChange={e => setOrgData(p => ({ ...p, email: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" placeholder="info@company.com" /></div>
                    <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">Phone</label><input type="tel" value={orgData.phone} onChange={e => setOrgData(p => ({ ...p, phone: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" placeholder="+1 555 123 4567" /></div>
                </div>
                <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">Website</label><input type="url" value={orgData.website} onChange={e => setOrgData(p => ({ ...p, website: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" placeholder="www.beeflow.nl" /></div>
                <div className="grid grid-cols-2 gap-4">
                    <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">Chamber of Commerce</label><input type="text" value={orgData.kvk} onChange={e => setOrgData(p => ({ ...p, kvk: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" placeholder="12345678" /></div>
                    <div><label className="block text-sm font-medium mb-1 text-[var(--text-primary)]">VAT Number</label><input type="text" value={orgData.vat} onChange={e => setOrgData(p => ({ ...p, vat: e.target.value }))} className="w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]" placeholder="XX123456789" /></div>
                </div>
                <div>
                    <label className="flex items-center gap-3 cursor-pointer p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)]">
                        <input type="checkbox" checked={orgData.allowSignup || false} onChange={e => setOrgData(p => ({ ...p, allowSignup: e.target.checked }))} className="accent-[var(--accent-primary)] w-4 h-4" />
                        <div>
                            <span className="text-sm font-medium block text-[var(--text-primary)]">Allow Public Signup</span>
                            <span className="text-xs text-[var(--text-muted)]">Users can register themselves for this organization</span>
                        </div>
                    </label>
                </div>
                <div>
                    <label className="block text-sm font-medium mb-2 text-[var(--text-primary)]">Default Groups</label>
                    <p className="text-xs mb-2 text-[var(--text-muted)]">New users will be automatically assigned to these groups</p>
                    <div className="max-h-40 overflow-auto p-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)]">
                        {groups.filter(g => !g.organizationId || g.organizationId === orgData.id).map(g => (
                            <label key={g.id} className="flex items-center gap-2.5 cursor-pointer px-2 py-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors">
                                <input type="checkbox" checked={(orgData.defaultGroups || []).includes(g.id)} onChange={e => setOrgData(prev => ({ ...prev, defaultGroups: e.target.checked ? [...(prev.defaultGroups || []), g.id] : (prev.defaultGroups || []).filter(x => x !== g.id) }))} className="accent-[var(--accent-primary)] w-4 h-4" />
                                <div className="flex-1 min-w-0">
                                    <span className="text-sm font-medium block text-[var(--text-primary)]">{g.name}</span>
                                    {g.description && <span className="text-xs text-[var(--text-muted)]">{g.description}</span>}
                                </div>
                            </label>
                        ))}
                        {groups.length === 0 && <p className="text-sm px-2 py-1 text-[var(--text-muted)]">No groups available. Create groups first.</p>}
                    </div>
                </div>
                {/* Enabled Integrations (Super Admin only) */}
                {isFullAdmin && showEditOrg && (
                    <div>
                        <label className="block text-sm font-medium mb-2 text-[var(--text-primary)]">Enabled Integrations</label>
                        <p className="text-xs mb-2 text-[var(--text-muted)]">Control which integrations are available for this organization. Deselect all then re-select to customize.</p>
                        <div className="flex items-center gap-2 mb-3">
                            <button
                                onClick={() => setOrgData(p => ({ ...p, enabledIntegrations: null }))}
                                className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all bg-[var(--bg-tertiary)] text-[var(--text-primary)] ${orgData.enabledIntegrations === null ? 'ring-2 ring-[var(--accent-primary)]' : ''}`}
                            >All Enabled</button>
                            <button
                                onClick={() => setOrgData(p => ({ ...p, enabledIntegrations: p.enabledIntegrations === null ? ALL_INTEGRATIONS.map(i => i.id) : p.enabledIntegrations }))}
                                className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all bg-[var(--bg-tertiary)] text-[var(--text-primary)] ${orgData.enabledIntegrations !== null ? 'ring-2 ring-[var(--accent-primary)]' : ''}`}
                            >Custom</button>
                        </div>
                        {orgData.enabledIntegrations !== null && (
                            <div className="grid grid-cols-2 gap-2 p-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)]">
                                {ALL_INTEGRATIONS.map(integ => {
                                    const isOn = (orgData.enabledIntegrations || []).includes(integ.id);
                                    return (
                                        <label key={integ.id} className="flex items-center gap-2.5 cursor-pointer px-2 py-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors">
                                            <input type="checkbox" checked={isOn} onChange={e => {
                                                setOrgData(prev => ({
                                                    ...prev,
                                                    enabledIntegrations: e.target.checked
                                                        ? [...(prev.enabledIntegrations || []), integ.id]
                                                        : (prev.enabledIntegrations || []).filter(x => x !== integ.id),
                                                }));
                                            }} className="accent-[var(--accent-primary)] w-4 h-4" />
                                            <span className="text-sm text-[var(--text-primary)]">{integ.label}</span>
                                        </label>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </Modal>
    );
}
