import { Building2 } from 'lucide-react';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import OrgAiContextEditor from './OrgAiContextEditor';
import OrgIntegrationCacheEditor from './OrgIntegrationCacheEditor';
import OrgAuthSection from './orgInfo/OrgAuthSection';
import OrgInfoSection from './orgInfo/OrgInfoSection';
import { Skeleton, SECTIONS } from './orgInfo/orgInfoShared';
import OrgLicenseSection from './orgInfo/OrgLicenseSection';
import { useDeploymentMode } from '../../../hooks/useDeploymentMode';
import { useTranslation } from '../../../hooks/useTranslation';
import { cloudFetch } from '../../../utils/cloudFetch';
import { API_BASE, authFetch } from '../../../utils/helpers';
import { useLicenseContext } from '../../licensing/LicenseContext';
import OrgEncryptionEditor from '../security/encryption/OrgEncryptionEditor';
import OrgShieldEditor from '../security/guardrails/orgShield/OrgShieldEditor';

const OrgInfoPanel = ({ user, activeSection, onSave: parentOnSave, onStateChange }) => {
    const { t } = useTranslation();
    const licenseCtx = useLicenseContext();
    const hasActiveLicenseKey = licenseCtx?.source === 'license_key';
    const { isCloud, isSelfHosted } = useDeploymentMode();
    // Licence-key management belongs to the admin dashboard, not to per-org
    // settings. On cloud, org settings shows the Stripe subscription ONLY —
    // never a licence-key card (even for Full-tier internal/operator orgs;
    // they manage their key under Admin → Server licence / License keys). On
    // self-hosted there are no subscriptions, so licence keys ARE the org's
    // paid-access mechanism and stay visible here.
    const showLicenseActivation = isSelfHosted;
    const deploymentMode = user?.featureFlags?.deploymentMode || 'cloud';
    const ncOrg = user?.ncOrg || null;
    const isNcOrg = !!ncOrg?.instanceId;
    const [organizations, setOrganizations] = useState([]);
    const [groups, setGroups] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState(null);
    const [orgData, setOrgData] = useState(null);
    const [hasChanges, setHasChanges] = useState(false);
    const [subscription, setSubscription] = useState(null);
    const [subLoading, setSubLoading] = useState(false);
    const [availablePlans, setAvailablePlans] = useState([]);
    const [stripeEnabled, setStripeEnabled] = useState(false);
    const [checkoutLoading, setCheckoutLoading] = useState(null);
    const [portalLoading, setPortalLoading] = useState(false);
    // Inline plan-picker shown when an already-subscribed org wants to
    // upgrade. Drives /api/subscriptions/orgs/:orgId/upgrade — no Stripe
    // redirect; the subscription stays the same and Stripe pro-rates.
    const [showChangePlan, setShowChangePlan] = useState(false);
    const [cancelBusy, setCancelBusy] = useState(false);
    // Subscription actions (upgrade/downgrade/cancel/checkout/portal) surface
    // their result HERE — kept separate from `message` so they never appear in
    // the org-info save bar (which only handles form saves + the usage toggle).
    const [subMessage, setSubMessage] = useState(null);
    // Change-plan confirmation flow: the selected target plan + the prorated
    // cost preview fetched from /preview-change before we commit the switch.
    const [changeTarget, setChangeTarget] = useState(null);
    const [changePreview, setChangePreview] = useState(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [changeBusy, setChangeBusy] = useState(false);
    // In-app cancel confirmation (replaces the native window.confirm dialog).
    const [showCancelConfirm, setShowCancelConfirm] = useState(false);
    // True between landing on ?checkout=success and the webhook flipping
    // status to active/trialing. Drives a "Subscription activating…" banner
    // so the user never sees stale "no subscription" copy after paying.
    const [checkoutSettling, setCheckoutSettling] = useState(false);
    const originalDataRef = useRef(null);

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            const [orgsRes, groupsRes] = await Promise.all([
                authFetch(`${API_BASE}/auth/organizations`),
                authFetch(`${API_BASE}/auth/groups`),
            ]);
            let orgs = [];
            let grps = [];
            if (orgsRes.ok) orgs = await orgsRes.json();
            if (groupsRes.ok) grps = await groupsRes.json();
            setOrganizations(orgs);
            setGroups(grps);

            if (orgs.length > 0) {
                // Prefer the user's directly-assigned organizationId
                let myOrg = null;
                if (user?.organizationId) {
                    myOrg = orgs.find(o => o.id === user.organizationId);
                }
                // Self-heal: cached user prop may predate an org rename or
                // NC-bootstrap re-binding (or simply be empty for a fresh
                // session). Always re-query /auth/user when we got orgs back
                // but couldn't match against user.organizationId — the SaaS
                // is the authority for the current binding.
                if (!myOrg) {
                    try {
                        const fresh = await authFetch(`${API_BASE}/auth/user`).then(r => r.ok ? r.json() : null);
                        const freshOrgId = fresh?.user?.organizationId;
                        if (freshOrgId) {
                            myOrg = orgs.find(o => o.id === freshOrgId);
                        }
                    } catch (_) { /* best-effort */ }
                }
                // Fallback: detect from group membership
                if (!myOrg) {
                    const userGroups = user?.groups || [];
                    const userOrgIds = new Set();
                    for (const gid of userGroups) {
                        const g = grps.find(gr => gr.id === gid);
                        if (g?.organizationId) userOrgIds.add(g.organizationId);
                    }
                    myOrg = orgs.find(o => userOrgIds.has(o.id));
                }
                // Final fallback for global admins: show first org
                if (!myOrg && (user?.role === 'admin')) {
                    myOrg = orgs[0];
                }
                if (!myOrg) {
                    setLoading(false);
                    return;
                }
                const data = {
                    id: myOrg.id,
                    name: myOrg.name || '',
                    description: myOrg.description || '',
                    tagline: myOrg.tagline || '',
                    address: myOrg.address || '',
                    billingLine2: myOrg.billingLine2 || '',
                    billingPostalCode: myOrg.billingPostalCode || '',
                    billingCity: myOrg.billingCity || '',
                    billingCountry: myOrg.billingCountry || '',
                    email: myOrg.email || '',
                    phone: myOrg.phone || '',
                    website: myOrg.website || '',
                    kvk: myOrg.kvk || '',
                    vat: myOrg.vat || '',
                    logo: myOrg.logo || '',
                    footerText: myOrg.footerText || '',
                    defaultGroups: myOrg.defaultGroups || [],
                    allowSignup: !!myOrg.allowSignup,
                    authMethod: myOrg.authMethod || null,
                    autoApproveSSO: !!myOrg.autoApproveSSO,
                    // Default to pooled (true) when the column is null on
                    // pre-migration orgs — matches the server-side default.
                    usagePooled: myOrg.usagePooled === undefined ? true : !!myOrg.usagePooled,
                    allowedDomains: Array.isArray(myOrg.allowedDomains) ? myOrg.allowedDomains : [],
                };
                setOrgData(data);
                originalDataRef.current = JSON.stringify(data);
                setHasChanges(false);
            }
        } catch (err) {
            console.error('Failed to fetch org data:', err);
        } finally {
            setLoading(false);
        }
    }, [user]);

    // Fetch subscription data
    const fetchSubscription = useCallback(async (orgId) => {
        if (!orgId) return;
        setSubLoading(true);
        try {
            const res = await cloudFetch(deploymentMode, `${API_BASE}/api/subscriptions/orgs/${orgId}`);
            if (res?.ok) {
                const data = await res.json();
                setSubscription(data);
            } else {
                // 403 = user not in org or no subscription assigned — expected, handle silently.
                // skipped = self-hosted (no /api/subscriptions mount).
                setSubscription(null);
            }
        } catch (err) {
            // Network error — not a 403, log it
            console.warn('[OrgInfoPanel] Failed to fetch subscription:', err);
            setSubscription(null);
        } finally {
            setSubLoading(false);
        }
    }, [deploymentMode]);

    useEffect(() => { fetchData(); }, [fetchData]);

    // Fetch available Stripe plans and status
    const fetchStripePlans = useCallback(async () => {
        try {
            const [statusRes, plansRes] = await Promise.all([
                cloudFetch(deploymentMode, `${API_BASE}/api/stripe/status`),
                cloudFetch(deploymentMode, `${API_BASE}/api/stripe/plans`),
            ]);
            if (statusRes?.ok) {
                const statusData = await statusRes.json();
                setStripeEnabled(statusData.enabled);
            }
            if (plansRes?.ok) {
                const plansData = await plansRes.json();
                setAvailablePlans(plansData);
            }
        } catch (err) {
            console.warn('[OrgInfoPanel] Failed to fetch Stripe plans:', err);
        }
    }, [deploymentMode]);

    useEffect(() => {
        if (orgData?.id) {
            fetchSubscription(orgData.id);
        }
        fetchStripePlans();
    }, [orgData?.id, fetchSubscription, fetchStripePlans]);

    // Handle Stripe checkout return URLs. The success branch polls every
    // 1.5s for up to 30s until the subscription flips to active/trialing —
    // the previous single-setTimeout left the UI showing "no subscription"
    // when the webhook took longer than 2s, which is the common path on
    // first-checkout (Stripe issues the event after the redirect).
    useEffect(() => {
        if (!orgData?.id) return;
        const params = new URLSearchParams(window.location.search);
        const status = params.get('checkout');
        if (status === 'cancelled') {
            setMessage({ type: 'error', text: 'Checkout was cancelled. No changes were made.' });
            window.history.replaceState({}, '', window.location.pathname);
            return;
        }
        if (status !== 'success') return;

        const sessionId = params.get('session_id');
        let cancelled = false;
        setCheckoutSettling(true);
        const deadline = Date.now() + 30000;
        (async () => {
            while (!cancelled && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 1500));
                try {
                    // Reconcile straight from the Stripe session so activation
                    // doesn't depend on the webhook landing in time (or at all).
                    if (sessionId) {
                        await cloudFetch(deploymentMode, `${API_BASE}/api/stripe/sessions/${encodeURIComponent(sessionId)}`).catch(() => {});
                    }
                    const res = await cloudFetch(deploymentMode, `${API_BASE}/api/subscriptions/orgs/${orgData.id}`);
                    if (res?.ok) {
                        const fresh = await res.json();
                        if (fresh && (fresh.status === 'active' || fresh.status === 'trialing')) {
                            if (cancelled) return;
                            setSubscription(fresh);
                            setCheckoutSettling(false);
                            setMessage({ type: 'success', text: '🎉 Subscription activated!' });
                            window.history.replaceState({}, '', window.location.pathname);
                            return;
                        }
                    }
                } catch (_) { /* keep polling */ }
            }
            if (!cancelled) {
                setCheckoutSettling(false);
                setMessage({
                    type: 'error',
                    text: 'Payment received, but activation is taking longer than expected. Refresh in a minute or email info@beeflow.nl.'
                });
                window.history.replaceState({}, '', window.location.pathname);
            }
        })();
        return () => { cancelled = true; };
    }, [orgData?.id]);

    const handleCheckout = async (planId) => {
        setCheckoutLoading(planId);
        try {
            const res = await cloudFetch(deploymentMode, `${API_BASE}/api/stripe/checkout`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ planId, origin: window.location.origin }),
            });
            const data = res?.skipped ? {} : await res.json();
            if (res.ok && data.url) {
                window.location.href = data.url;
            } else {
                setSubMessage({ type: 'error', text: data.error || 'Failed to start checkout' });
            }
        } catch {
            setSubMessage({ type: 'error', text: 'Failed to connect to payment service' });
        } finally {
            setCheckoutLoading(null);
        }
    };

    // Step 1 of a plan change: select a target and fetch the prorated cost
    // preview. Opens the confirmation modal once the preview resolves.
    const handleSelectChange = async (plan) => {
        if (!orgData?.id) return;
        setChangeTarget(plan);
        setChangePreview(null);
        setPreviewLoading(true);
        try {
            const res = await cloudFetch(deploymentMode, `${API_BASE}/api/subscriptions/orgs/${orgData.id}/preview-change`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ planId: plan.id }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || data.error || 'Could not preview this change');
            setChangePreview(data);
        } catch (e) {
            setSubMessage({ type: 'error', text: e.message });
            setChangeTarget(null);
        } finally {
            setPreviewLoading(false);
        }
    };

    // Step 2: commit. Same endpoint handles both directions — upgrades apply
    // now (prorated), downgrades are scheduled at period end by the server.
    const handleConfirmChange = async () => {
        if (!orgData?.id || !changeTarget) return;
        setChangeBusy(true);
        try {
            const res = await cloudFetch(deploymentMode, `${API_BASE}/api/subscriptions/orgs/${orgData.id}/upgrade`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ planId: changeTarget.id }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                const friendly = data.message
                    || ({
                        payment_required: 'Your card was declined. Update your payment method via "Manage Billing".',
                        interval_mismatch: 'Switching between monthly and yearly billing is not available here. Contact info@beeflow.nl.',
                    }[data.error])
                    || data.error
                    || 'Plan change failed';
                throw new Error(friendly);
            }
            setSubscription(data);
            const msg = changeTarget.direction === 'downgrade'
                ? t('org.downgrade_scheduled_msg', 'Downgrade scheduled for the end of this period.')
                : t('org.upgrade_done_msg', 'Plan upgraded. Stripe invoiced the prorated difference.');
            setSubMessage({ type: 'success', text: msg });
            setShowChangePlan(false);
            setChangeTarget(null);
            setChangePreview(null);
        } catch (e) {
            setSubMessage({ type: 'error', text: e.message });
        } finally {
            setChangeBusy(false);
        }
    };

    const handleCancelDowngrade = async () => {
        if (!orgData?.id) return;
        setCancelBusy(true);
        try {
            const res = await cloudFetch(deploymentMode, `${API_BASE}/api/subscriptions/orgs/${orgData.id}/cancel-downgrade`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || data.error || 'Could not cancel the scheduled change');
            setSubscription(data);
            setSubMessage({ type: 'success', text: t('org.downgrade_cancelled_msg', 'Scheduled downgrade cancelled — you stay on your current plan.') });
        } catch (e) {
            setSubMessage({ type: 'error', text: e.message });
        } finally {
            setCancelBusy(false);
        }
    };

    // Opens the in-app confirmation modal (no native window.confirm).
    const handleCancelSubscription = () => setShowCancelConfirm(true);

    const doCancelSubscription = async () => {
        if (!orgData?.id) return;
        setCancelBusy(true);
        try {
            const res = await cloudFetch(deploymentMode, `${API_BASE}/api/subscriptions/orgs/${orgData.id}/cancel`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || data.error || 'Cancel failed');
            setSubscription(data);
            setSubMessage({ type: 'success', text: t('org.cancel_scheduled_msg', 'Cancellation scheduled.') });
        } catch (e) {
            setSubMessage({ type: 'error', text: e.message });
        } finally {
            setCancelBusy(false);
            setShowCancelConfirm(false);
        }
    };

    const handleReactivateSubscription = async () => {
        if (!orgData?.id) return;
        setCancelBusy(true);
        try {
            const res = await cloudFetch(deploymentMode, `${API_BASE}/api/subscriptions/orgs/${orgData.id}/reactivate`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || data.error || 'Reactivate failed');
            setSubscription(data);
            setSubMessage({ type: 'success', text: 'Subscription will continue.' });
        } catch (e) {
            setSubMessage({ type: 'error', text: e.message });
        } finally {
            setCancelBusy(false);
        }
    };

    const handleManageBilling = async () => {
        setPortalLoading(true);
        try {
            const res = await cloudFetch(deploymentMode, `${API_BASE}/api/stripe/portal`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ origin: window.location.origin }),
            });
            const data = res?.skipped ? {} : await res.json();
            if (res.ok && data.url) {
                window.location.href = data.url;
            } else {
                setSubMessage({ type: 'error', text: data.error || 'Failed to open billing portal' });
            }
        } catch {
            setSubMessage({ type: 'error', text: 'Failed to connect to billing portal' });
        } finally {
            setPortalLoading(false);
        }
    };

    // BFSF-251: jump to the org Users panel where seats are added (inviting a
    // user is what adds a billed seat on per-seat plans). Mirrors the app's own
    // back/forward routing — pushState the canonical settings URL, then fire a
    // popstate so the AdvancedSettings shell switches to the Users sub-tab.
    const goToUsersPanel = () => {
        const url = '/app/settings/organisation/users';
        try {
            if (window.location.pathname !== url) window.history.pushState({}, '', url);
            window.dispatchEvent(new PopStateEvent('popstate'));
        } catch {
            window.location.href = url;
        }
    };

    useEffect(() => {
        if (orgData && originalDataRef.current) {
            setHasChanges(JSON.stringify(orgData) !== originalDataRef.current);
        }
    }, [orgData]);

    useEffect(() => {
        if (message) {
            const timer = setTimeout(() => setMessage(null), 3000);
            return () => clearTimeout(timer);
        }
    }, [message]);

    const handleSave = async () => {
        if (!orgData?.id) return;
        setSaving(true);
        try {
            const res = await authFetch(`${API_BASE}/auth/organizations/${orgData.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(orgData),
            });
            if (res.ok) {
                setMessage({ type: 'success', text: 'Changes saved' });
                originalDataRef.current = JSON.stringify(orgData);
                setHasChanges(false);
                if (parentOnSave) parentOnSave();
            } else {
                const data = await res.json();
                setMessage({ type: 'error', text: data.error || 'Failed to save' });
            }
        } catch (err) {
            setMessage({ type: 'error', text: 'Connection error' });
        } finally {
            setSaving(false);
        }
    };

    // Notify parent of save state
    useEffect(() => {
        if (onStateChange) onStateChange({ hasChanges, saving, message, handleSave });
    }, [hasChanges, saving, message]);

    const handleLogoUpload = async (e) => {
        const file = e.target.files[0];
        if (!file || !orgData?.id) return;
        const formData = new FormData();
        formData.append('logo', file);
        try {
            const res = await authFetch(`${API_BASE}/auth/organizations/${orgData.id}/logo`, {
                method: 'POST',
                body: formData,
            });
            if (res.ok) {
                const data = await res.json();
                setOrgData(p => ({ ...p, logo: data.logo }));
                setMessage({ type: 'success', text: 'Logo uploaded' });
            }
        } catch (err) {
            setMessage({ type: 'error', text: 'Upload failed' });
        }
    };

    const handleLogoRemove = async () => {
        if (!orgData?.id) return;
        try {
            await authFetch(`${API_BASE}/auth/organizations/${orgData.id}/logo`, { method: 'DELETE' });
            setOrgData(p => ({ ...p, logo: '' }));
            setMessage({ type: 'success', text: 'Logo removed' });
        } catch (err) {
            setMessage({ type: 'error', text: 'Failed to remove logo' });
        }
    };

    const isAuthLocked = !!orgData?.authMethod;

    if (loading) return <Skeleton />;

    if (!orgData) {
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

    // The Privacy Shield owns its whole viewport: its own header, its own
    // scrolling pane and a save bar pinned to the bottom. This panel's default
    // `overflow-y-auto p-6` would give it a second scrollbar, 24px it does not
    // want, and no height to fill — so the save bar would float under the last
    // card instead of sitting at the foot of the screen.
    const sectionOwnsViewport = activeSection === 'privacy';

    return (
        <div className={sectionOwnsViewport ? 'flex-1 min-h-0 flex flex-col' : 'flex-1 overflow-y-auto p-6'}>

                {/* ── License & Usage ── */}
                {activeSection === 'license' && (
                    <OrgLicenseSection
                        t={t}
                        licenseCtx={licenseCtx}
                        hasActiveLicenseKey={hasActiveLicenseKey}
                        showLicenseActivation={showLicenseActivation}
                        isCloud={isCloud}
                        deploymentMode={deploymentMode}
                        orgData={orgData}
                        setOrgData={setOrgData}
                        subscription={subscription}
                        subLoading={subLoading}
                        subMessage={subMessage}
                        setSubMessage={setSubMessage}
                        checkoutSettling={checkoutSettling}
                        availablePlans={availablePlans}
                        checkoutLoading={checkoutLoading}
                        handleCheckout={handleCheckout}
                        portalLoading={portalLoading}
                        handleManageBilling={handleManageBilling}
                        showChangePlan={showChangePlan}
                        setShowChangePlan={setShowChangePlan}
                        handleSelectChange={handleSelectChange}
                        previewLoading={previewLoading}
                        changeTarget={changeTarget}
                        setChangeTarget={setChangeTarget}
                        changePreview={changePreview}
                        setChangePreview={setChangePreview}
                        changeBusy={changeBusy}
                        handleConfirmChange={handleConfirmChange}
                        cancelBusy={cancelBusy}
                        handleCancelDowngrade={handleCancelDowngrade}
                        handleReactivateSubscription={handleReactivateSubscription}
                        handleCancelSubscription={handleCancelSubscription}
                        doCancelSubscription={doCancelSubscription}
                        showCancelConfirm={showCancelConfirm}
                        setShowCancelConfirm={setShowCancelConfirm}
                        goToUsersPanel={goToUsersPanel}
                    />
                )}

                {/* ── Sign-in Method ── */}
                {activeSection === 'auth' && (
                    <OrgAuthSection
                        t={t}
                        isAuthLocked={isAuthLocked}
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
                {/* ── Conversation memory (compaction) ── */}
                {activeSection === 'ai_context' && (
                    /* Same orgId discipline as the two editors above: no org
                       picker and no orgs[0] fallback — this switch changes how
                       every conversation in the org is built. */
                    <div className="animate-fadeIn max-w-3xl">
                        <OrgAiContextEditor orgId={orgData?.id} />
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
