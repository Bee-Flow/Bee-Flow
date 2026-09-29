import { AlertTriangle, Loader2, Package } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { buildResolutions, readBlueprint } from './installRequirements';
import { AccessStep, ConnectStep, ContentsStep, ResultStep } from './installWizardSteps';
import useRemote, { readJson } from './useRemote';
import { useTranslation } from '../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../utils/helpers';
import Modal from '../shared/Modal';

/**
 * Installing a Blueprint, as three questions instead of one button.
 *
 * ── Why a wizard at all ────────────────────────────────────────────────────
 *
 * Installing used to be: pick a file, and a Solution appears. Everything the
 * Blueprint deliberately did NOT carry — which table each step uses, which
 * credential, who approves — arrived empty, and everything it DID ask for that
 * an install refuses to grant arrived refused, both of them explained only in a
 * report nobody had a reason to read twice. So the same three screens the
 * export dialog shows the sender are now shown to the recipient, before
 * anything is created:
 *
 *   1 Contents  what is in it, and what a Blueprint never brings
 *   2 Connect   the holes, each one a question with an answer that installs
 *   3 Access    who else can reach it
 *
 * ── The step that carries the security of this screen ──────────────────────
 *
 * A page's `bridge_grants` run AS THE PAGE'S AUTHOR, who after an install is
 * whoever pressed the button. A Blueprint from another organisation asking for
 * `gmail_send` is asking for authority over the installer's account, and one
 * asking for `publicEnabled` is asking to let anonymous visitors spend their AI
 * budget. install.js grants NONE of it — see its "bridge grants are REQUIRES"
 * header — and this step is the other half of that decision: the requests are
 * listed, unticked, and handing one over is an act the installer performs.
 *
 * Which is why a ticked tool is not sent to the install route at all. It goes,
 * afterwards, to the PAGE'S OWN grants route — the same endpoint the webpage
 * IDE's "add an app" form posts to, so it meets the same owner check and the
 * same 409 `connection_required` refusal for an app the installer has not
 * connected. Routing it through the install body instead would have created a
 * second way into that column, which is exactly what this stage removed.
 *
 * Public AI is shown and NOT offered: there is no REST route that sets it (only
 * the page's own AI chat can), so a control here would be a promise this screen
 * cannot keep.
 *
 * ── Empty and unreadable never look the same ───────────────────────────────
 *
 * Every list this screen loads — the table catalogue, the credentials, the
 * people — can be genuinely empty. Each one therefore carries its own status,
 * and a failed load says so rather than rendering as "there are none": a picker
 * that silently offers nothing teaches somebody their organisation has no
 * tables. The same rule applies to the Blueprint itself: a gallery Blueprint
 * that will not load blocks the wizard rather than installing something nobody
 * could see.
 */

const INSTALL_URL = `${API_BASE}/api/projects/package/install`;

// ── The wizard ─────────────────────────────────────────────────────

/**
 * The wizard's controls, which are a different question on every step.
 *
 * A separate component because "which button is showing" is the whole of the
 * wizard's state machine, and reading it in one place is the only way to see
 * that Install appears exactly once — on the last step before anything is
 * created.
 */
function WizardFooter({ step, ready, busy, onBack, onNext, onInstall, onDone }) {
    const { t } = useTranslation();
    return (
        <>
            <span className="mr-auto text-[11px]" style={{ color: 'var(--text-tertiary)' }} data-testid="install-footer-note">
                {t('solutions.install_footer_draft', 'Everything arrives as a draft.')}
            </span>
            {step > 1 && step < 4 && (
                <button
                    type="button"
                    onClick={onBack}
                    className="px-3 py-1.5 rounded-lg text-sm border"
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                >
                    {t('solutions.install_back', 'Back')}
                </button>
            )}
            {step < 3 && (
                <button
                    type="button"
                    onClick={onNext}
                    disabled={!ready}
                    className="px-3 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                    style={{ background: 'var(--accent-primary)' }}
                    data-testid="install-next"
                >
                    {t('solutions.install_next', 'Next')}
                </button>
            )}
            {step === 3 && (
                <button
                    type="button"
                    onClick={onInstall}
                    disabled={busy || !ready}
                    className="px-3 py-1.5 rounded-lg text-sm font-medium text-white flex items-center gap-1 disabled:opacity-50"
                    style={{ background: 'var(--accent-primary)' }}
                    data-testid="install-confirm"
                >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Package className="w-3.5 h-3.5" />}
                    {t('solutions.install_confirm', 'Install')}
                </button>
            )}
            {step === 4 && (
                <button
                    type="button"
                    onClick={onDone}
                    className="px-3 py-1.5 rounded-lg text-sm font-medium text-white"
                    style={{ background: 'var(--accent-primary)' }}
                    data-testid="install-done"
                >
                    {t('solutions.install_open', 'Open it')}
                </button>
            )}
        </>
    );
}

const EMPTY_CHOICES = { tables: {}, connections: {}, approvers: {}, grants: {} };

export default function InstallBlueprintModal({ open, source, onClose, onInstalled }) {
    const { t } = useTranslation();
    const [step, setStep] = useState(1);
    const [name, setName] = useState('');
    const [choices, setChoices] = useState(EMPTY_CHOICES);
    const [access, setAccess] = useState([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [result, setResult] = useState(null);
    const [failures, setFailures] = useState([]);

    // A gallery Blueprint arrives as an id; the manifest has to be fetched
    // before there is anything to describe. A file already carries it.
    const fetched = useRemote(
        source?.blueprintId ? `${API_BASE}/api/projects/package/blueprints/${encodeURIComponent(source.blueprintId)}` : null,
        open && !!source?.blueprintId,
    );
    const manifest = source?.manifest || fetched.data?.blueprint?.manifest || null;
    const read = useMemo(() => readBlueprint(manifest), [manifest]);

    useEffect(() => {
        if (!open) return;
        setStep(1);
        setChoices(EMPTY_CHOICES);
        setAccess([]);
        setError('');
        setResult(null);
        setFailures([]);
    }, [open, source]);

    useEffect(() => {
        if (read.ok) setName(read.name || '');
    }, [read.ok, read.name]);

    // Loaded per step: most installs never open step 3, and four requests for a
    // dialog somebody may close again is four requests too many.
    const catalog = useRemote(`${API_BASE}/api/automation/catalog`, open && step === 2);
    const connections = useRemote(`${API_BASE}/api/integrations/connections`, open && step === 2);
    const people = useRemote(`${API_BASE}/auth/users`, open && (step === 2 || step === 3));
    const groups = useRemote(`${API_BASE}/auth/groups`, open && (step === 2 || step === 3));

    /**
     * Hand over the tools the installer ticked — through the PAGE'S OWN grants
     * route, never through the install body.
     *
     * That route is the one the webpage IDE posts to, so this meets the same
     * owner check and the same 409 for an app the installer has not connected.
     * A failure is collected and shown; it must not read as though the grant
     * went through.
     */
    const grantTicked = useCallback(async (report) => {
        const idByRef = new Map((report?.installed?.webpages || []).map(w => [w.ref, w.id]));
        const problems = [];
        for (const row of Object.values(choices.grants)) {
            // `false` is an unticked box, kept in state so untick is a state
            // change rather than a deletion. Only a row travels.
            if (!row) continue;
            const webpageId = idByRef.get(row.ref);
            if (!webpageId) {
                problems.push(t('solutions.install_grant_no_page',
                    '{tool} could not be granted: that page was not installed.', { tool: row.tool }));
                continue;
            }
            try {
                const res = await authFetch(`${API_BASE}/api/webpages/${encodeURIComponent(webpageId)}/grants/integrations`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tool: row.tool }),
                });
                if (!res.ok) {
                    const body = await readJson(res);
                    problems.push(t('solutions.install_grant_failed', '{tool} could not be granted: {why}',
                        { tool: row.tool, why: body?.error || String(res.status) }));
                }
            } catch {
                problems.push(t('solutions.install_grant_failed', '{tool} could not be granted: {why}',
                    { tool: row.tool, why: t('solutions.install_unreachable', 'the server could not be reached') }));
            }
        }
        return problems;
    }, [choices.grants, t]);

    const shareWith = useCallback(async (projectId) => {
        const problems = [];
        for (const entry of access) {
            try {
                const res = await authFetch(`${API_BASE}/api/projects/${encodeURIComponent(projectId)}/share`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sharedWithType: entry.type, sharedWithId: entry.id, permission: entry.permission }),
                });
                if (!res.ok) {
                    const body = await readJson(res);
                    problems.push(t('solutions.install_share_failed', '{who} could not be added: {why}',
                        { who: entry.id, why: body?.error || String(res.status) }));
                }
            } catch {
                problems.push(t('solutions.install_share_failed', '{who} could not be added: {why}',
                    { who: entry.id, why: t('solutions.install_unreachable', 'the server could not be reached') }));
            }
        }
        return problems;
    }, [access, t]);

    const install = async () => {
        setBusy(true);
        setError('');
        try {
            const res = await authFetch(INSTALL_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...(source?.blueprintId ? { blueprintId: source.blueprintId } : { manifest }),
                    ...(name.trim() ? { name: name.trim() } : {}),
                    resolutions: buildResolutions(read.requires, choices),
                }),
            });
            const payload = await readJson(res);
            if (!res.ok) {
                setError(payload?.error === 'feature_locked'
                    ? t('projects.blueprint_locked', 'Installing a Blueprint is not part of this plan.')
                    : (payload?.error || t('projects.blueprint_install_failed', 'The install failed.')));
                return;
            }
            // The Solution exists from here on, so nothing below may turn into
            // "the install failed": each part reports its own outcome.
            const problems = [
                ...(await grantTicked(payload.report)),
                ...(await shareWith(payload.projectId)),
            ];
            setFailures(problems);
            setResult(payload);
            setStep(4);
        } catch {
            setError(t('projects.blueprint_install_failed', 'The install failed.'));
        } finally {
            setBusy(false);
        }
    };

    const titles = {
        1: t('solutions.install_step_contents', 'What is in it'),
        2: t('solutions.install_step_connect', 'Connect it up'),
        3: t('solutions.install_step_access', 'Who can reach it'),
        4: t('solutions.install_step_done', 'Installed'),
    };

    const loading = fetched.status === 'loading';
    // Anything that is not still loading and is not readable gets the sentence
    // — a file that is not a Blueprint, a gallery row that 404'd, and a row
    // that came back without a manifest at all. Rendering an empty step 1 for
    // the third case would be the wizard's own version of "silence reads as
    // good news".
    const unreadable = !loading && !read.ok && step < 4;

    return (
        <Modal
            open={open}
            onClose={onClose}
            size="lg"
            /* 680px. A responsive variant always outranks the preset's base
               utility, which the documented `className` escape on its own does
               not guarantee. */
            className="sm:max-w-[680px]"
            title={t('solutions.install_title', 'Install a Blueprint')}
            description={`${step <= 3 ? `${step}/3 · ` : ''}${titles[step]}`}
            footer={(
                <WizardFooter
                    step={step}
                    ready={read.ok}
                    busy={busy}
                    onBack={() => setStep(step - 1)}
                    onNext={() => setStep(step + 1)}
                    onInstall={install}
                    onDone={() => { onInstalled?.(result?.projectId); onClose(); }}
                />
            )}
        >
            {loading && (
                <p className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {t('solutions.install_loading', 'Reading the Blueprint…')}
                </p>
            )}

            {unreadable && (
                <p className="flex items-start gap-2 text-sm" style={{ color: 'var(--text-primary)' }} data-testid="install-unreadable">
                    <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--warning)' }} />
                    {t('solutions.install_unreadable',
                        'That Blueprint could not be read, so there is nothing to describe and nothing has been installed.')}
                </p>
            )}

            {error && (
                <p className="flex items-start gap-2 text-sm mb-3" style={{ color: 'var(--text-primary)' }} data-testid="install-error">
                    <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--warning)' }} />
                    {error}
                </p>
            )}

            {read.ok && step === 1 && <ContentsStep read={read} name={name} onName={setName} />}
            {read.ok && step === 2 && (
                <ConnectStep
                    read={read} catalog={catalog} connections={connections}
                    people={people} groups={groups} choices={choices} setChoices={setChoices}
                />
            )}
            {read.ok && step === 3 && (
                <AccessStep people={people} groups={groups} access={access} setAccess={setAccess} />
            )}
            {step === 4 && <ResultStep result={result} failures={failures} />}
        </Modal>
    );
}
