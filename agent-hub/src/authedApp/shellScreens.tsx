import React from 'react';
import beeFlowLogo from '../assets/bee-flow-logo.svg';
import beeFlowIcon from '../assets/BeeFlow-logo-Icon-2026.svg';
import { useTranslation } from '../hooks/useTranslation';
import type { TranslateFn } from '../hooks/useTranslation';

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
        <div className="[display:flex] [align-items:center] [justify-content:center] min-h-[60vh] [color:var(--text-muted)]">
            {t('app.loading', 'Loading…')}
        </div>
    );
}

/* Matches the shell background painted by index.html, so a chunk fetch never
   shows through as white. Duplicated from App.jsx on purpose: importing
   anything from App.jsx here would defeat the split (see header). */
export function AppBackdrop() {
    return <div className="[background:#06090F] min-h-[100vh]" />;
}

interface BrandProps {
    useOrgBrand: boolean;
    orgLogo?: string | null;
    t: TranslateFn;
}

/** What the connector's bootstrap reported while the server was unreachable. */
export interface BootstrapDiagnostics {
    state?: string;
    lastError?: {
        category?: string;
        error?: string;
        remediation?: string;
        nextRetryAt?: string | number;
    } | null;
}

interface ServerUnavailableScreenProps extends BrandProps {
    bootstrapDiagnostics?: BootstrapDiagnostics | null;
}

// Loading spinner while checking auth.
export function LoadingScreen({ useOrgBrand, orgLogo, t }: BrandProps) {
    return (
        <div className="h-screen flex items-center justify-center [background:var(--bg-primary)]">
            <div className="flex flex-col items-center gap-4">
                <img
                    src={useOrgBrand ? orgLogo ?? undefined : beeFlowIcon}
                    alt={useOrgBrand ? 'Organization' : 'Bee Flow'}
                    className={`w-16 h-16 rounded-2xl animate-pulse ${useOrgBrand ? 'object-contain' : 'object-contain'}`}
                />
                <p className="text-[var(--text-secondary)] text-sm">{t('app.loading', 'Loading...')}</p>
            </div>
        </div>
    );
}

// Server is unreachable — show a clear error instead of the product website.
export function ServerUnavailableScreen({ useOrgBrand, orgLogo, bootstrapDiagnostics, t }: ServerUnavailableScreenProps) {
    return (
        <div className="h-[100vh] [display:flex] [align-items:center] [justify-content:center] [background:var(--bg-primary)] [padding:24px]">
            <div className="max-w-[420px] w-[100%] [text-align:center] [background:var(--bg-secondary)] [border:1px_solid_var(--border-subtle)] [border-radius:24px] [padding:40px_32px] [box-shadow:0_20px_60px_rgba(0,0,0,0.15)] [position:relative] [overflow:hidden]">
                <div className="[position:absolute] [top:0] [left:10%] [right:10%] h-[1px] [background:linear-gradient(90deg,transparent,var(--border-default),transparent)]" />
                <img
                    src={useOrgBrand ? (orgLogo ?? undefined) : beeFlowIcon}
                    alt={useOrgBrand ? 'Organization' : 'Bee Flow'}
                    className="w-[64px] h-[64px] [border-radius:18px] [margin:0_auto_20px] [object-fit:contain] [display:block]"
                />
                <div className="w-[52px] h-[52px] [border-radius:14px] [margin:0_auto_16px] [background:rgba(239,68,68,0.1)] [display:flex] [align-items:center] [justify-content:center]">
                    <svg width="26" height="26" fill="none" stroke="#ef4444" strokeWidth="1.5" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                    </svg>
                </div>
                <h2 className="[margin:0_0_10px] [font-size:18px] [font-weight:700] [color:var(--text-primary)]">
                    {bootstrapDiagnostics?.state === 'awaiting_admin_approval'
                        ? t('app.bootstrap_pending_title', 'Setup awaiting approval')
                        : bootstrapDiagnostics?.state === 'failed'
                            ? t('app.bootstrap_failed_title', 'Bee Flow setup failed')
                            : t('app.server_unavailable_title', 'Server Unavailable')}
                </h2>
                <p className="[margin:0_0_20px] [font-size:14px] [color:var(--text-secondary)] [line-height:1.65]">
                    {bootstrapDiagnostics?.state === 'awaiting_admin_approval'
                        ? t('app.bootstrap_pending_desc', 'A Bee Flow admin needs to approve this Nextcloud as part of an existing organisation. The setup will continue automatically once approved.')
                        : bootstrapDiagnostics?.lastError
                            ? `${bootstrapDiagnostics.lastError.category}: ${bootstrapDiagnostics.lastError.error}`
                            : t('app.server_unavailable_desc', 'Could not connect to the Bee Flow server. Please make sure the server is running and try again.')}
                </p>
                {bootstrapDiagnostics?.lastError && (
                    <details className="[margin:0_0_24px] [text-align:left] [background:var(--bg-primary)] [border:1px_solid_var(--border-subtle)] [border-radius:10px] [padding:12px_14px] [font-size:13px] [color:var(--text-secondary)] [line-height:1.6]">
                        <summary className="[cursor:pointer] [font-weight:600] [color:var(--text-primary)]">
                            {t('app.bootstrap_show_remediation', 'How to fix this')}
                        </summary>
                        <p className="[margin-top:10px] [margin-bottom:8px]">
                            {bootstrapDiagnostics.lastError.remediation || t('app.bootstrap_no_remediation', 'See docs.beeflow.ai/connector/troubleshooting for diagnostic commands.')}
                        </p>
                        {bootstrapDiagnostics.lastError.nextRetryAt && (
                            <p className="[margin:0] [font-size:12px] [opacity:0.7]">
                                {t('app.bootstrap_next_retry', 'Next retry')}: {new Date(bootstrapDiagnostics.lastError.nextRetryAt).toLocaleTimeString()}
                            </p>
                        )}
                    </details>
                )}
                <button
                    onClick={() => window.location.reload()}
                    className="w-[100%] [padding:11px_0] [border-radius:12px] [background:linear-gradient(135deg,#f59e0b,#d97706)] [color:#fff] [font-weight:600] [font-size:14px] [border:none] [cursor:pointer] [box-shadow:0_4px_12px_rgba(245,158,11,0.3)]"
                >
                    {t('app.retry_connection', 'Retry Connection')}
                </button>
            </div>
        </div>
    );
}

// No-organisation gate for SSO users without org membership.
export function NoOrganizationScreen({ handleLogout }: { handleLogout: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="h-screen flex items-center justify-center p-4 [background:linear-gradient(160deg,var(--bg-primary)_0%,var(--bg-secondary)_50%,var(--bg-tertiary)_100%)]">
            <div className="w-full max-w-md">
                <div className="backdrop-blur-xl rounded-3xl p-8 shadow-2xl border relative overflow-hidden text-center [background:var(--bg-secondary)] [border-color:var(--border-subtle)]">
                    <div className="absolute top-0 left-8 right-8 h-px bg-gradient-to-r from-transparent via-[var(--border-default)] to-transparent" />
                    <div className="w-20 h-20 mx-auto mb-5 rounded-full overflow-hidden shadow-xl ring-4 ring-[var(--border-subtle)]">
                        <img src={beeFlowLogo} alt={t('app.shell_logo_alt', 'Bee Flow')} className="w-full h-full object-cover" />
                    </div>
                    <div className="w-14 h-14 mx-auto mb-4 rounded-2xl flex items-center justify-center [background:rgba(245,158,11,0.1)]">
                        <svg className="w-7 h-7" fill="none" stroke="#f59e0b" viewBox="0 0 24 24" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                        </svg>
                    </div>
                    <h2 className="text-lg font-bold mb-2 text-[var(--text-primary)]">{t('app.shell_no_org_title', 'No Organisation Found')}</h2>
                    <p className="text-sm mb-6 [color:var(--text-secondary)]! [line-height:1.6]">
                        {t('app.shell_no_org_body', 'Your account is not linked to any organisation yet. Please ask your administrator to create an account for you, or sign up with a new organisation.')}
                    </p>
                    <div className="flex gap-3">
                        <button
                            onClick={handleLogout}
                            className="flex-1 py-2.5 rounded-xl font-medium text-sm border transition-colors hover:bg-[var(--bg-tertiary)] [border-color:var(--border-default)] [color:var(--text-primary)]!"
                        >
                            {t('sidebar.sign_out', 'Sign Out')}
                        </button>
                        <button
                            onClick={() => { handleLogout(); setTimeout(() => { window.location.href = '/?signup=1'; }, 300); }}
                            className="flex-1 py-2.5 rounded-xl font-semibold text-sm text-white [background:var(--accent-primary)]"
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
export function PendingApprovalScreen({ user, handleLogout }: { user: { isConsumerAccount?: boolean } | null; handleLogout: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="h-screen flex items-center justify-center p-4 [background:linear-gradient(160deg,var(--bg-primary)_0%,var(--bg-secondary)_50%,var(--bg-tertiary)_100%)]">
            <div className="w-full max-w-md">
                <div className="backdrop-blur-xl rounded-3xl p-8 shadow-2xl border relative overflow-hidden text-center [background:var(--bg-secondary)] [border-color:var(--border-subtle)]">
                    <div className="absolute top-0 left-8 right-8 h-px bg-gradient-to-r from-transparent via-[var(--border-default)] to-transparent" />
                    <div className="w-20 h-20 mx-auto mb-5 rounded-full overflow-hidden shadow-xl ring-4 ring-[var(--border-subtle)]">
                        <img src={beeFlowLogo} alt={t('app.shell_logo_alt', 'Bee Flow')} className="w-full h-full object-cover" />
                    </div>
                    <div className="w-14 h-14 mx-auto mb-4 rounded-2xl flex items-center justify-center [background:rgba(59,130,246,0.1)]">
                        <svg className="w-7 h-7" fill="none" stroke="#3b82f6" viewBox="0 0 24 24" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                    </div>
                    <h2 className="text-lg font-bold mb-2 text-[var(--text-primary)]">{t('app.shell_awaiting_approval_title', 'Awaiting Approval')}</h2>
                    <p className="text-sm mb-6 [color:var(--text-secondary)]! [line-height:1.6]">
                        {user?.isConsumerAccount
                            ? t('app.shell_awaiting_approval_consumer', 'Your account has been created and is being reviewed. An administrator will approve your access shortly.')
                            : t('app.shell_awaiting_approval_org', 'Your account has been created and linked to an organisation, but it needs to be approved by an administrator before you can access the platform.')
                        }
                    </p>
                    <button
                        onClick={handleLogout}
                        className="w-full py-2.5 rounded-xl font-medium text-sm border transition-colors hover:bg-[var(--bg-tertiary)] [border-color:var(--border-default)] [color:var(--text-primary)]!"
                    >
                        {t('sidebar.sign_out', 'Sign Out')}
                    </button>
                </div>
            </div>
        </div>
    );
}
