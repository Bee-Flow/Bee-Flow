import React from 'react';
import beeFlowLogo from '../assets/bee-flow-logo.svg';
import beeFlowIcon from '../assets/BeeFlow-logo-Icon-2026.svg';
import { useTranslation } from '../hooks/useTranslation';

/**
 * Full-screen states of the authenticated shell, lifted verbatim out of
 * AuthedApp.jsx: the two Suspense/route fallbacks and the four gates that
 * return instead of the app (loading, server unreachable, no organisation,
 * awaiting approval). Every value they used to read from <App/>'s scope is
 * threaded in as a prop under the same name, so the markup is unchanged.
 */

export function RouteFallback() {
    const { t } = useTranslation();
    return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', color: 'var(--text-muted)' }}>
            {t('app.loading', 'Loading…')}
        </div>
    );
}

/* Matches the shell background painted by index.html, so a chunk fetch never
   shows through as white. Duplicated from App.jsx on purpose: importing
   anything from App.jsx here would defeat the split (see header). */
export function AppBackdrop() {
    return <div style={{ background: '#06090F', minHeight: '100vh' }} />;
}

// Loading spinner while checking auth.
export function LoadingScreen({ useOrgBrand, orgLogo, t }) {
    return (
        <div className="h-screen flex items-center justify-center" style={{ background: 'var(--bg-primary)' }}>
            <div className="flex flex-col items-center gap-4">
                <img
                    src={useOrgBrand ? orgLogo : beeFlowIcon}
                    alt={useOrgBrand ? 'Organization' : 'Bee Flow'}
                    className={`w-16 h-16 rounded-2xl animate-pulse ${useOrgBrand ? 'object-contain' : 'object-contain'}`}
                />
                <p className="text-[var(--text-secondary)] text-sm">{t('app.loading', 'Loading...')}</p>
            </div>
        </div>
    );
}

// Server is unreachable — show a clear error instead of the product website.
export function ServerUnavailableScreen({ useOrgBrand, orgLogo, bootstrapDiagnostics, t }) {
    return (
        <div style={{
            height: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--bg-primary)',
            padding: '24px',
        }}>
            <div style={{
                maxWidth: 420,
                width: '100%',
                textAlign: 'center',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 24,
                padding: '40px 32px',
                boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
                position: 'relative',
                overflow: 'hidden',
            }}>
                <div style={{
                    position: 'absolute', top: 0, left: '10%', right: '10%',
                    height: 1,
                    background: 'linear-gradient(90deg, transparent, var(--border-default), transparent)',
                }} />
                <img
                    src={useOrgBrand ? orgLogo : beeFlowIcon}
                    alt={useOrgBrand ? 'Organization' : 'Bee Flow'}
                    style={{
                        width: 64, height: 64, borderRadius: 18, margin: '0 auto 20px',
                        objectFit: 'contain',
                        display: 'block',
                    }}
                />
                <div style={{
                    width: 52, height: 52, borderRadius: 14, margin: '0 auto 16px',
                    background: 'rgba(239, 68, 68, 0.1)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                    <svg width="26" height="26" fill="none" stroke="#ef4444" strokeWidth="1.5" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                    </svg>
                </div>
                <h2 style={{ margin: '0 0 10px', fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {bootstrapDiagnostics?.state === 'awaiting_admin_approval'
                        ? t('app.bootstrap_pending_title', 'Setup awaiting approval')
                        : bootstrapDiagnostics?.state === 'failed'
                            ? t('app.bootstrap_failed_title', 'Bee Flow setup failed')
                            : t('app.server_unavailable_title', 'Server Unavailable')}
                </h2>
                <p style={{ margin: '0 0 20px', fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.65 }}>
                    {bootstrapDiagnostics?.state === 'awaiting_admin_approval'
                        ? t('app.bootstrap_pending_desc', 'A Bee Flow admin needs to approve this Nextcloud as part of an existing organisation. The setup will continue automatically once approved.')
                        : bootstrapDiagnostics?.lastError
                            ? `${bootstrapDiagnostics.lastError.category}: ${bootstrapDiagnostics.lastError.error}`
                            : t('app.server_unavailable_desc', 'Could not connect to the Bee Flow server. Please make sure the server is running and try again.')}
                </p>
                {bootstrapDiagnostics?.lastError && (
                    <details style={{
                        margin: '0 0 24px',
                        textAlign: 'left',
                        background: 'var(--bg-primary)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 10,
                        padding: '12px 14px',
                        fontSize: 13,
                        color: 'var(--text-secondary)',
                        lineHeight: 1.6,
                    }}>
                        <summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--text-primary)' }}>
                            {t('app.bootstrap_show_remediation', 'How to fix this')}
                        </summary>
                        <p style={{ marginTop: 10, marginBottom: 8 }}>
                            {bootstrapDiagnostics.lastError.remediation || t('app.bootstrap_no_remediation', 'See docs.beeflow.ai/connector/troubleshooting for diagnostic commands.')}
                        </p>
                        {bootstrapDiagnostics.lastError.nextRetryAt && (
                            <p style={{ margin: 0, fontSize: 12, opacity: 0.7 }}>
                                {t('app.bootstrap_next_retry', 'Next retry')}: {new Date(bootstrapDiagnostics.lastError.nextRetryAt).toLocaleTimeString()}
                            </p>
                        )}
                    </details>
                )}
                <button
                    onClick={() => window.location.reload()}
                    style={{
                        width: '100%', padding: '11px 0', borderRadius: 12,
                        background: 'linear-gradient(135deg, #f59e0b, #d97706)',
                        color: '#fff', fontWeight: 600, fontSize: 14,
                        border: 'none', cursor: 'pointer',
                        boxShadow: '0 4px 12px rgba(245,158,11,0.3)',
                    }}
                >
                    {t('app.retry_connection', 'Retry Connection')}
                </button>
            </div>
        </div>
    );
}

// No-organisation gate for SSO users without org membership.
export function NoOrganizationScreen({ handleLogout }) {
    const { t } = useTranslation();
    return (
        <div className="h-screen flex items-center justify-center p-4" style={{ background: 'linear-gradient(160deg, var(--bg-primary) 0%, var(--bg-secondary) 50%, var(--bg-tertiary) 100%)' }}>
            <div className="w-full max-w-md">
                <div className="backdrop-blur-xl rounded-3xl p-8 shadow-2xl border relative overflow-hidden text-center" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
                    <div className="absolute top-0 left-8 right-8 h-px bg-gradient-to-r from-transparent via-[var(--border-default)] to-transparent" />
                    <div className="w-20 h-20 mx-auto mb-5 rounded-full overflow-hidden shadow-xl ring-4 ring-[var(--border-subtle)]">
                        <img src={beeFlowLogo} alt={t('app.shell_logo_alt', 'Bee Flow')} className="w-full h-full object-cover" />
                    </div>
                    <div className="w-14 h-14 mx-auto mb-4 rounded-2xl flex items-center justify-center" style={{ background: 'rgba(245, 158, 11, 0.1)' }}>
                        <svg className="w-7 h-7" fill="none" stroke="#f59e0b" viewBox="0 0 24 24" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                        </svg>
                    </div>
                    <h2 className="text-lg font-bold mb-2" style={{ color: 'var(--text-primary)' }}>{t('app.shell_no_org_title', 'No Organisation Found')}</h2>
                    <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)', lineHeight: '1.6' }}>
                        {t('app.shell_no_org_body', 'Your account is not linked to any organisation yet. Please ask your administrator to create an account for you, or sign up with a new organisation.')}
                    </p>
                    <div className="flex gap-3">
                        <button
                            onClick={handleLogout}
                            className="flex-1 py-2.5 rounded-xl font-medium text-sm border transition-colors hover:bg-[var(--bg-tertiary)]"
                            style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                        >
                            {t('sidebar.sign_out', 'Sign Out')}
                        </button>
                        <button
                            onClick={() => { handleLogout(); setTimeout(() => { window.location.href = '/?signup=1'; }, 300); }}
                            className="flex-1 py-2.5 rounded-xl font-semibold text-sm text-white"
                            style={{ background: 'var(--accent-primary)' }}
                        >
                            {t('app.shell_sign_up_instead', 'Sign Up Instead')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

// Pending-approval gate for SSO users awaiting admin approval.
export function PendingApprovalScreen({ user, handleLogout }) {
    const { t } = useTranslation();
    return (
        <div className="h-screen flex items-center justify-center p-4" style={{ background: 'linear-gradient(160deg, var(--bg-primary) 0%, var(--bg-secondary) 50%, var(--bg-tertiary) 100%)' }}>
            <div className="w-full max-w-md">
                <div className="backdrop-blur-xl rounded-3xl p-8 shadow-2xl border relative overflow-hidden text-center" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
                    <div className="absolute top-0 left-8 right-8 h-px bg-gradient-to-r from-transparent via-[var(--border-default)] to-transparent" />
                    <div className="w-20 h-20 mx-auto mb-5 rounded-full overflow-hidden shadow-xl ring-4 ring-[var(--border-subtle)]">
                        <img src={beeFlowLogo} alt={t('app.shell_logo_alt', 'Bee Flow')} className="w-full h-full object-cover" />
                    </div>
                    <div className="w-14 h-14 mx-auto mb-4 rounded-2xl flex items-center justify-center" style={{ background: 'rgba(59, 130, 246, 0.1)' }}>
                        <svg className="w-7 h-7" fill="none" stroke="#3b82f6" viewBox="0 0 24 24" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                    </div>
                    <h2 className="text-lg font-bold mb-2" style={{ color: 'var(--text-primary)' }}>{t('app.shell_awaiting_approval_title', 'Awaiting Approval')}</h2>
                    <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)', lineHeight: '1.6' }}>
                        {user?.isConsumerAccount
                            ? t('app.shell_awaiting_approval_consumer', 'Your account has been created and is being reviewed. An administrator will approve your access shortly.')
                            : t('app.shell_awaiting_approval_org', 'Your account has been created and linked to an organisation, but it needs to be approved by an administrator before you can access the platform.')
                        }
                    </p>
                    <button
                        onClick={handleLogout}
                        className="w-full py-2.5 rounded-xl font-medium text-sm border transition-colors hover:bg-[var(--bg-tertiary)]"
                        style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                    >
                        {t('sidebar.sign_out', 'Sign Out')}
                    </button>
                </div>
            </div>
        </div>
    );
}
