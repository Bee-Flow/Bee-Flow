/**
 * Security Scan Studio — module entry.
 *
 * Built by Vite in library mode (see ../vite.config.js) into `frontend/index.js`
 * (ESM). The react family is EXTERNALISED — the host provides the single React
 * instance via its import map — so this bundle never ships its own React. lucide
 * icons and Tailwind CSS are bundled. Theme flows through the host CSS variables.
 *
 * The host mounts this default export inside a per-module error boundary +
 * Suspense.
 *
 * On mount we gate on the scanner toolbox image (Track C): if the isolated
 * scanner container image isn't installed, we show an operator-only provisioning
 * panel that builds or pulls it (streaming progress), then re-checks and hands
 * off to the scan UI once the image is ready.
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import {
    ShieldAlert, Hammer, DownloadCloud, Loader2, RefreshCw,
    CheckCircle, AlertTriangle, Terminal as TerminalIcon,
} from 'lucide-react';
import './index.css';
import SecurityStudio from './SecurityStudio';
import useTranslation from './i18n';
import { apiFetch, streamProvision } from './api';

// Operator detection mirrors the host's common signal (user.isAdmin / role).
// Unknown user → permissive: the server authorizes /toolbox/provision anyway.
function isOperator(user) {
    if (!user) return true;
    return !!(user.isAdmin || user.is_admin
        || ['admin', 'owner', 'superadmin', 'super_admin'].includes(user.role));
}

export default function App(props) {
    // phase: 'loading' | 'ready' | 'needs' | 'error'
    const [phase, setPhase] = useState('loading');
    const [status, setStatus] = useState(null);
    const [checkError, setCheckError] = useState(null);

    const checkStatus = useCallback(async () => {
        try {
            const res = await apiFetch('/toolbox/status');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setStatus(data);
            setCheckError(null);
            setPhase(data.imageOk ? 'ready' : 'needs');
        } catch (e) {
            setCheckError(e.message || 'status_failed');
            setPhase('error');
        }
    }, []);

    useEffect(() => { checkStatus(); }, [checkStatus]);

    if (phase === 'loading') {
        return (
            <div className="flex items-center justify-center w-full h-full py-20 bg-[var(--bg-primary)]">
                <Loader2 className="animate-spin" size={22} style={{ color: 'var(--accent-primary)' }} />
            </div>
        );
    }
    if (phase === 'ready') {
        return <SecurityStudio {...props} />;
    }
    return (
        <ProvisionPanel
            status={status}
            checkError={checkError}
            user={props.user}
            onRecheck={checkStatus}
        />
    );
}

/**
 * ProvisionPanel — operator-only "scanner image not installed" surface.
 * Amber / slate / emerald + the severity red only; NO purple.
 */
function ProvisionPanel({ status, checkError, user, onRecheck }) {
    const { t } = useTranslation();

    const dockerOk = status ? status.dockerOk !== false : true;
    const canPull = !!(status && status.canPull);
    const canBuild = status ? status.canBuild !== false : true;
    const image = status?.image || null;
    const operator = isOperator(user);

    const [running, setRunning] = useState(null); // 'build' | 'pull' | null
    const [log, setLog] = useState([]);
    const [pct, setPct] = useState(null);
    const [phaseLabel, setPhaseLabel] = useState(null);
    const [error, setError] = useState(null);
    const [done, setDone] = useState(false);
    const abortRef = useRef(null);
    const logRef = useRef(null);

    useEffect(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    }, [log.length]);

    useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

    const run = async (mode) => {
        if (running) return;
        setRunning(mode);
        setLog([]);
        setPct(null);
        setPhaseLabel(null);
        setError(null);
        setDone(false);
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        let streamError = null;
        try {
            await streamProvision(mode, (evt) => {
                if (!evt || typeof evt !== 'object') return;
                if (typeof evt.pct === 'number') setPct(Math.max(0, Math.min(100, evt.pct)));
                if (evt.phase) setPhaseLabel(String(evt.phase));
                if (evt.line != null) setLog((l) => [...l, String(evt.line)].slice(-500));
                if (evt.error) { streamError = String(evt.error); setError(streamError); }
            }, ctrl.signal);

            // Stream finished — re-check whether the image is now present.
            const res = await apiFetch('/toolbox/status');
            const data = res.ok ? await res.json() : null;
            if (data?.imageOk) {
                setPct(100);
                setDone(true);
                onRecheck(); // flips App → scan UI
            } else if (!streamError) {
                setError(t('security_studio.provision.failed'));
            }
        } catch (e) {
            if (e.name !== 'AbortError') setError(e.message || t('security_studio.provision.failed'));
        } finally {
            setRunning(null);
            abortRef.current = null;
        }
    };

    return (
        <div className="w-full h-full overflow-auto bg-[var(--bg-primary)] text-[var(--text-primary)] flex items-start justify-center p-6">
            <div className="w-full max-w-2xl mt-8 flex flex-col gap-5">
                {/* Header */}
                <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 w-11 h-11 rounded-xl flex items-center justify-center bg-amber-500/15 border border-amber-500/30">
                        <ShieldAlert size={22} className="text-amber-500" />
                    </div>
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <h2 className="text-base font-semibold">{t('security_studio.provision.title')}</h2>
                            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] border border-[var(--border-default)]">
                                {t('security_studio.provision.subtitle')}
                            </span>
                        </div>
                        <p className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">
                            {t('security_studio.provision.body')}
                        </p>
                        {image && (
                            <div className="mt-2 text-[11px] font-mono px-2 py-1 rounded bg-[var(--bg-secondary)] border border-[var(--border-default)] text-[var(--text-secondary)] inline-block break-all">
                                {image}
                            </div>
                        )}
                    </div>
                </div>

                {checkError && (
                    <div className="text-xs text-amber-600 bg-amber-500/10 border border-amber-500/40 rounded p-2.5">
                        Could not read scanner status ({checkError}). You can still try to provision below.
                    </div>
                )}

                {!dockerOk && (
                    <div className="flex items-start gap-2 text-xs text-amber-600 bg-amber-500/10 border border-amber-500/40 rounded p-2.5">
                        <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                        <span>{t('security_studio.provision.docker_down')}</span>
                    </div>
                )}

                {/* Actions */}
                {operator ? (
                    <div className="flex items-center gap-2 flex-wrap">
                        <button
                            onClick={() => run('build')}
                            disabled={!!running || !dockerOk || !canBuild}
                            className="flex items-center gap-1.5 px-3.5 py-2 text-sm rounded-lg font-semibold text-white bg-amber-600 hover:bg-amber-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {running === 'build' ? <Loader2 size={14} className="animate-spin" /> : <Hammer size={14} />}
                            {running === 'build' ? t('security_studio.provision.working') : t('security_studio.provision.build')}
                        </button>

                        {canPull && (
                            <button
                                onClick={() => run('pull')}
                                disabled={!!running || !dockerOk}
                                className="flex items-center gap-1.5 px-3.5 py-2 text-sm rounded-lg font-semibold border border-amber-500/50 text-amber-600 hover:bg-amber-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {running === 'pull' ? <Loader2 size={14} className="animate-spin" /> : <DownloadCloud size={14} />}
                                {running === 'pull' ? t('security_studio.provision.working') : t('security_studio.provision.pull')}
                            </button>
                        )}

                        <button
                            onClick={onRecheck}
                            disabled={!!running}
                            className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition-colors disabled:opacity-50"
                        >
                            <RefreshCw size={14} /> {t('security_studio.provision.recheck')}
                        </button>
                    </div>
                ) : (
                    <div className="text-xs text-[var(--text-secondary)] bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded p-3 leading-relaxed">
                        An operator with Docker access must install the scanner image on this host before scans can run.
                    </div>
                )}

                {/* Progress */}
                {(running || pct != null || done) && (
                    <div className="flex flex-col gap-1.5">
                        <div className="flex items-center justify-between text-[11px] text-[var(--text-tertiary)]">
                            <span className="flex items-center gap-1.5">
                                {done
                                    ? <CheckCircle size={12} className="text-emerald-500" />
                                    : <Loader2 size={12} className="animate-spin" />}
                                {done ? t('security_studio.provision.done') : (phaseLabel || t('security_studio.provision.working'))}
                            </span>
                            {pct != null && <span>{Math.round(pct)}%</span>}
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
                            <div
                                className={`h-full rounded-full transition-all ${done ? 'bg-emerald-500' : 'bg-amber-500'}`}
                                style={{ width: `${pct != null ? Math.round(pct) : (running ? 25 : 0)}%` }}
                            />
                        </div>
                    </div>
                )}

                {error && (
                    <div className="flex items-start gap-2 text-xs text-red-600 bg-red-500/10 border border-red-500/40 rounded p-2.5">
                        <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                        <span className="break-all">{t('security_studio.provision.failed')}: {error}</span>
                    </div>
                )}

                {/* Live log console */}
                {(running || log.length > 0) && (
                    <div className="flex flex-col">
                        <h4 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-1">
                            <TerminalIcon size={11} /> Provisioning log
                        </h4>
                        <div
                            ref={logRef}
                            className="max-h-72 min-h-[120px] font-mono text-[11px] bg-[#0b0e14] text-slate-200 rounded border border-[var(--border-default)] p-3 overflow-auto overscroll-contain"
                        >
                            {log.length === 0
                                ? <span className="text-slate-500 italic">Starting…</span>
                                : log.map((line, i) => (
                                    <div key={i} className="whitespace-pre-wrap break-all [overflow-wrap:anywhere]">{line}</div>
                                ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
