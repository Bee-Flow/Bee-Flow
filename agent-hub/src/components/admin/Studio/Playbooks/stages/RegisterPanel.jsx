import { AlertTriangle, BookOpen, CheckCircle2, ExternalLink, Info, Loader2, Sparkles } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TONES } from '../../../../shared/statusTone';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import { basisOptions, dateColumns, registrationDefaults, registrationSources, retentionWords, subjectColumns } from './complianceView';
import { playbooksApi } from '../playbooksApi';

/** Art. 6(1) — the six the datatable itself accepts, in the order they are used. */
const LAWFUL_BASES = ['contract', 'legal_obligation', 'legitimate_interests', 'consent', 'public_task', 'vital_interests'];
const BASIS_WORDS = {
    consent: 'Consent',
    contract: 'Performance of a contract',
    legal_obligation: 'A legal obligation',
    vital_interests: 'Vital interests',
    public_task: 'A public task',
    legitimate_interests: 'Legitimate interests',
};

/**
 * The Art. 30 record for the table this playbook built.
 *
 * Three things the rehearsal made obvious (owner, 2026-09-16):
 *  - it opens FILLED IN. The subject-column picker used to open on "—" with
 *    twenty columns in it, so the one piece of work the phase asks for was
 *    also the fiddliest.
 *  - a retention period is checked against the rows that really exist. "Keep
 *    for 365 days" is a number until someone asks the table what it means, and
 *    a date column that holds no dates is a period that never fires.
 *  - personal data is PLURAL. The findings already name several columns; the
 *    record says so too, instead of behaving as if one column were the story.
 */
export default function RegisterPanel({
    playbookId, phaseKey, facts, t, presenter = false, busy = false, error = null,
    onRegister, registered = null, onNavigate = null, writtenLines = [], onSuggest = null,
}) {
    const table = (facts && facts.table) || null;
    const defaults = useMemo(() => registrationDefaults(facts), [facts]);
    const sources = useMemo(() => registrationSources(facts), [facts]);
    const bases = useMemo(() => basisOptions(facts, LAWFUL_BASES), [facts]);
    const [reg, setReg] = useState(defaults);
    // The facts change under this panel when the review is re-run; a field the
    // person has touched is theirs, the rest follow the new facts.
    const touched = useRef(false);
    const seeded = useRef(JSON.stringify(defaults));
    useEffect(() => {
        const next = JSON.stringify(defaults);
        if (seeded.current === next || touched.current) return;
        seeded.current = next;
        setReg(defaults);
    }, [defaults]);
    const set = (patch) => { touched.current = true; setReg((r) => ({ ...r, ...patch })); };

    // ── what the period would mean here ─────────────────────────────
    const [preview, setPreview] = useState(null);
    const [previewError, setPreviewError] = useState(null);
    const [checking, setChecking] = useState(false);
    const check = useCallback(async () => {
        const days = Number(reg.retentionDays);
        if (!playbookId || !reg.retentionField || !Number.isFinite(days) || days < 1) { setPreview(null); return; }
        setChecking(true);
        setPreviewError(null);
        try {
            setPreview(await playbooksApi.retentionPreview(playbookId, phaseKey, { retentionField: reg.retentionField, retentionDays: days }));
        } catch (e) {
            setPreview(null);
            setPreviewError(e?.message || t('playbooks.compliance.retention_failed', 'The table could not be read.'));
        } finally {
            setChecking(false);
        }
    }, [playbookId, phaseKey, reg.retentionField, reg.retentionDays, t]);
    // Once when the panel opens with its defaults, then whenever the pair
    // changes — a number that has not been checked is a number nobody trusts.
    useEffect(() => { check(); }, [check]);

    // ── let the AI fill it in ───────────────────────────────────────
    // It fills the FORM, it does not write: the Register button below stays
    // the only thing on this screen that changes anything, which is the same
    // promise every other part of the phase makes (owner, 2026-09-17).
    const [suggesting, setSuggesting] = useState(false);
    const [suggestion, setSuggestion] = useState(null);
    const suggest = useCallback(async () => {
        if (!onSuggest || suggesting) return;
        setSuggesting(true);
        try {
            const out = await onSuggest();
            if (out && out.registration) {
                touched.current = true;
                setReg((r) => ({ ...r, ...Object.fromEntries(Object.entries(out.registration).filter(([, v]) => v !== undefined && v !== null)) }));
            }
            setSuggestion(out || { note: null, error: t('playbooks.compliance.suggest_none', 'It had nothing to add to what is already here.') });
        } catch (e) {
            setSuggestion({ error: e?.message || t('playbooks.compliance.suggest_failed', 'It could not work out a suggestion.') });
        } finally {
            setSuggesting(false);
        }
    }, [onSuggest, suggesting, t]);

    if (!table) return null;

    if (registered) {
        return (
            <section
                className="rounded-2xl"
                style={{ border: `1px solid var(--kind-playbook)`, background: 'color-mix(in srgb, var(--kind-playbook) 6%, transparent)', padding: presenter ? 22 : 16 }}
                data-testid="playbook-compliance-registered"
            >
                <p className="flex items-center gap-2 font-semibold" style={{ fontSize: presenter ? 17 : 14, color: 'var(--text-primary)' }}>
                    <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: 'var(--kind-playbook)' }} aria-hidden="true" />
                    {t('playbooks.compliance.registered', 'Registered. It is in the Compliance Center now.')}
                </p>
                <ul className="mt-1.5 space-y-0.5">
                    {writtenLines.map((line, i) => (
                        <li key={i} className="flex items-start gap-1.5" style={{ fontSize: presenter ? 13 : 11, color: 'var(--text-secondary)' }}>
                            <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0" style={{ color: 'var(--kind-playbook)' }} aria-hidden="true" />{line}
                        </li>
                    ))}
                </ul>
                {onNavigate && (
                    <button
                        type="button"
                        onClick={() => onNavigate(`settings/organisation/compliance/ropa/${encodeURIComponent(`datatable:${table.id}`)}`)}
                        className="mt-2.5 inline-flex items-center gap-1 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                        style={{ color: 'var(--type-ai)', outlineColor: 'var(--type-ai)' }}
                        data-testid="playbook-compliance-open-ropa"
                    >
                        <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
                        {t('playbooks.compliance.open_ropa', 'Open this entry in the processing register')}
                        <ExternalLink className="w-3 h-3" aria-hidden="true" />
                    </button>
                )}
            </section>
        );
    }

    const columns = table.columns || [];
    const personal = subjectColumns(table);
    const dates = dateColumns(table, t);
    const words = retentionWords(preview, t);
    const label = 'block text-[11px] font-medium';
    const field = 'mt-1 w-full h-8 rounded-lg px-2 text-xs';
    const fieldStyle = { background: 'var(--bg-primary)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' };

    return (
        <section
            className="rounded-2xl space-y-3"
            style={{ border: '1px solid var(--border-default)', background: 'var(--bg-card)', boxShadow: 'var(--shadow-md)', padding: presenter ? 22 : 16 }}
            data-testid="playbook-compliance-register"
        >
            <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                    <h3 className="font-semibold" style={{ fontSize: presenter ? 17 : 14, color: 'var(--text-primary)' }}>
                        {t('playbooks.compliance.register_title', 'Record this processing')}
                    </h3>
                    <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                        {t('playbooks.compliance.register_intro', 'This is the Art. 30 record for "{table}". Registering also switches on the retention clean-up.', { table: table.name })}
                    </p>
                </div>
                {onSuggest && (
                    <button
                        type="button"
                        onClick={suggest}
                        disabled={suggesting}
                        className="shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] font-semibold disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                        style={{ color: 'var(--type-ai)', border: '1px solid var(--type-ai)', background: 'color-mix(in srgb, var(--type-ai) 8%, transparent)', outlineColor: 'var(--type-ai)' }}
                        data-testid="playbook-compliance-suggest"
                    >
                        {suggesting
                            ? <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                            : <Sparkles className="w-3 h-3" aria-hidden="true" />}
                        {t('playbooks.compliance.suggest', 'Fill this in with AI')}
                    </button>
                )}
            </div>
            {suggestion && (
                <p
                    className="flex items-start gap-1.5 text-[11px]"
                    style={{ color: suggestion.error ? 'var(--error-ink, var(--error))' : 'var(--text-secondary)' }}
                    data-testid="playbook-compliance-suggestion"
                >
                    {suggestion.error
                        ? <><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />{suggestion.error}</>
                        : <><Sparkles className="w-3 h-3 mt-0.5 shrink-0" style={{ color: 'var(--type-ai)' }} aria-hidden="true" />
                            {suggestion.note || t('playbooks.compliance.suggest_done', 'Filled in below — read it, change what you like, then press Register it.')}</>}
                </p>
            )}

            {/* Every column the review found personal data in — not one of them. */}
            {personal.length > 0 && (
                <div data-testid="playbook-compliance-categories">
                    <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                        {t('playbooks.compliance.categories', 'Personal data in this table')}
                    </span>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                        {personal.map((c) => (
                            <span
                                key={c.key}
                                className="inline-flex items-center gap-1 text-[11px] px-2 py-[2px] rounded-full"
                                style={{ border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                                title={facts.personalMethod === 'values'
                                    ? t('playbooks.compliance.cat_values', 'found by reading the values')
                                    : t('playbooks.compliance.cat_names', 'assumed from the column name')}
                            >
                                {c.name}
                                <span style={{ color: 'var(--text-tertiary)' }}>{facts.personalMethod === 'values' ? '·' : '~'}</span>
                            </span>
                        ))}
                    </div>
                </div>
            )}

            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
                {/* THE ONE FIELD THAT OPENS EMPTY, AND SAYS WHY.
                    It used to open on the organisation's first configured
                    ground, so Register was one click away from recording a
                    legal position nobody had taken — and Art. 6(1)(f) is a
                    balancing test with a documented assessment behind it, not
                    a default. The organisation's own grounds are still put at
                    the top of the list, because a shortlist is help; picking
                    from it is the part only the customer can do. */}
                <label className={label} style={{ color: 'var(--text-secondary)' }}>
                    {t('playbooks.compliance.legal_basis', 'Legal basis')}
                    <select
                        value={reg.lawfulBasis}
                        onChange={(e) => set({ lawfulBasis: e.target.value })}
                        className={field}
                        style={fieldStyle}
                        data-testid="playbook-compliance-basis"
                    >
                        <option value="">{t('playbooks.compliance.basis_choose', 'Choose one — we will not')}</option>
                        {bases.map(({ id, configured }) => (
                            <option key={id} value={id}>
                                {t(`playbooks.compliance.basis_${id}`, BASIS_WORDS[id])}
                                {configured ? ` · ${t('playbooks.compliance.basis_configured', 'used by your organisation')}` : ''}
                            </option>
                        ))}
                    </select>
                </label>
                <label className={label} style={{ color: 'var(--text-secondary)' }}>
                    {t('playbooks.compliance.retention', 'Keep for (days)')}
                    <input
                        type="number"
                        min="1"
                        max="3650"
                        value={reg.retentionDays}
                        onChange={(e) => set({ retentionDays: e.target.value })}
                        className={field}
                        style={fieldStyle}
                        data-testid="playbook-compliance-retention"
                    />
                    {/* A number that was worked out for you and a number this
                        table already had look identical in a box. Deriving is
                        allowed; saving it while the person thinks it was
                        already there is the half that is not. */}
                    {sources.retentionDays === 'derived' && String(reg.retentionDays) === String(defaults.retentionDays) && (
                        <span className="mt-0.5 block text-[10px]" style={{ color: 'var(--text-tertiary)' }} data-testid="playbook-compliance-retention-derived">
                            {t('playbooks.compliance.retention_derived', 'your organisation’s default — change it if this table is different')}
                        </span>
                    )}
                </label>
                <label className={label} style={{ color: 'var(--text-secondary)' }}>
                    {t('playbooks.compliance.retention_field', 'Counted from')}
                    <select
                        value={reg.retentionField}
                        onChange={(e) => set({ retentionField: e.target.value })}
                        className={field}
                        style={fieldStyle}
                        data-testid="playbook-compliance-retention-field"
                    >
                        <option value="">{t('playbooks.access.role_none', '—')}</option>
                        {dates.map((c) => <option key={c.key} value={c.key}>{c.name || c.key}</option>)}
                    </select>
                </label>
                <label className={label} style={{ color: 'var(--text-secondary)' }}>
                    {t('playbooks.compliance.subject_column', 'Which column names the person')}
                    <select
                        value={reg.subjectColumn}
                        onChange={(e) => set({ subjectColumn: e.target.value })}
                        className={field}
                        style={fieldStyle}
                        data-testid="playbook-compliance-subject"
                    >
                        <option value="">{t('playbooks.access.role_none', '—')}</option>
                        {columns.map((c) => <option key={c.key} value={c.key}>{c.name || c.key}</option>)}
                    </select>
                </label>
            </div>

            {/* What that period actually means for the rows that are there. */}
            {(checking || words || previewError) && (
                <p
                    className="flex items-start gap-1.5 text-[11px]"
                    style={{ color: previewError ? 'var(--error-ink, var(--error))' : words ? TONES[words.tone].ink : 'var(--text-secondary)' }}
                    data-testid="playbook-compliance-retention-check"
                >
                    {checking
                        ? <><Loader2 className="w-3 h-3 mt-0.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />{t('playbooks.compliance.retention_checking', 'Reading the table…')}</>
                        : previewError
                            ? <><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />{previewError}</>
                            : <>{words.tone === 'success'
                                ? <Info className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />
                                : <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />}{words.line}</>}
                </p>
            )}
            {!reg.retentionField && reg.retentionDays ? (
                <p className="flex items-start gap-1.5 text-[11px]" style={{ color: TONES.warning.ink }} data-testid="playbook-compliance-retention-pair">
                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />
                    {dates.length
                        ? t('playbooks.compliance.retention_needs_field', 'Pick the date the period is counted from, or the clean-up has nothing to measure.')
                        : t('playbooks.compliance.retention_no_dates', 'This table has no date column, so a retention period cannot be recorded for it yet.')}
                </p>
            ) : null}

            {/* The record is still recordable without a basis — a retention
                period on its own is worth having, and refusing the whole form
                over the one field nobody can fill in for you would be its own
                kind of dishonesty. What it may not do is go quiet about it. */}
            {!reg.lawfulBasis && (
                <p className="flex items-start gap-1.5 text-[11px]" style={{ color: TONES.warning.ink }} data-testid="playbook-compliance-basis-open">
                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />
                    {t('playbooks.compliance.basis_open', 'No legal basis chosen yet. Nothing here picks one for you — Art. 6 is a judgement about why you may hold this data, and a pre-filled answer would be us making it. The record stays incomplete until you choose.')}
                </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    onClick={() => onRegister(reg)}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
                    data-testid="playbook-compliance-register-go"
                >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />}
                    {t('playbooks.compliance.register_go', 'Register it')}
                </button>
                <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                    {t('playbooks.compliance.register_note', 'Nothing else on this screen writes anything.')}
                </span>
            </div>
            {error && <p role="alert" className="text-[11px]" style={{ color: 'var(--error-ink, var(--error))' }}>{error}</p>}
        </section>
    );
}
