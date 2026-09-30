/**
 * The compliance phase: what was built, read against the frameworks the
 * organisation switched on. A verdict first (what was checked, what came back
 * clean — never a clean bill of health it did not earn), then the things to
 * tidy up in the phase's own words, the quiet ones behind a count, and the
 * register form. The review itself writes nothing; Register is the one write.
 */

import React, { useState } from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Text } from '@/shared/ui';

import { FindingRow } from './FindingRow';
import { RegisterPanel } from './RegisterPanel';
import { StageCard } from './StageCard';
import { useRecheckCompliance, useRegisterCompliance } from '../hooks/mutations';
import { artList, artRecord, artRecords, textOf } from '../model/artifacts';
import { failedLine, groupFindings, methodLine, registrationBody, verdictOf } from '../model/complianceView';
import type { Phase, Playbook } from '../model/types';

function statusLine(phase: Phase, frameworks: string[], t: ReturnType<typeof useTranslation>): string {
    if (phase.status === 'failed') return phase.error || t('playbooks.compliance.failed', 'The review did not run — try it again.');
    if (phase.status === 'ready' || phase.status === 'running') return t('playbooks.compliance.running', 'Reading the table, the automations and the app…');
    return frameworks.length
        ? t('playbooks.compliance.against', 'Against: {list}', { list: frameworks.join(', ') })
        : t('playbooks.compliance.none_active', 'No framework is switched on in the Compliance Center, so there was nothing to check against.');
}

function Verdict({ playbook, phase }: { playbook: Playbook; phase: Phase }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const recheck = useRecheckCompliance(playbook.id, phase.key);
    const a = phase.artifacts;
    const verdict = verdictOf(a, t);
    const method = methodLine(artRecord(a, 'facts'), t);
    const rechecks = artRecords(a, 'rechecks');
    const last = rechecks[rechecks.length - 1];
    const fewer = last && Number(last.was) > Number(last.now) ? Number(last.was) - Number(last.now) : 0;
    return (
        <View style={styles.verdict} testID="playbook-compliance-verdict">
            <Text variant="heading" tone={verdict.tone === 'none' ? 'warning' : 'primary'} testID="playbook-compliance-headline">
                {verdict.headline}
            </Text>
            {verdict.cleanLine ? <Text variant="caption" tone="secondary">{verdict.cleanLine}</Text> : null}
            {method ? <Text variant="label" tone="tertiary">{method}</Text> : null}
            {fewer > 0 ? <Text variant="caption" tone="success">{t('playbooks.compliance.delta', '{n} fewer than a moment ago.', { n: fewer })}</Text> : null}
            {a.modelFailed ? (
                <Text variant="label" tone="tertiary">
                    {t('playbooks.compliance.model_note', 'The AI reviewer could not be reached — what you see is what the rules alone found.')}
                </Text>
            ) : null}
            <Button size="sm" variant="secondary" iconName="RefreshCw" label={t('playbooks.compliance.recheck', 'Check again')} loading={recheck.isPending} onPress={() => recheck.mutate()} testID="playbook-compliance-recheck" />
            {recheck.error ? <Text variant="caption" tone="error">{t('playbooks.compliance.recheck_failed', 'It could not be read again.')}</Text> : null}
        </View>
    );
}

/** The findings (the quiet ones behind a count) and the register form, once the review has landed. */
function Landed({ playbook, phase }: { playbook: Playbook; phase: Phase }) {
    const t = useTranslation();
    const a = phase.artifacts;
    const findings = artRecords(a, 'findings');
    const facts = artRecord(a, 'facts');
    const registered = artRecord(a, 'registered');
    const register = useRegisterCompliance(playbook.id, phase.key);
    const [keep, setKeep] = useState<string[] | null>(null);
    const [showLow, setShowLow] = useState(false);
    const kept = keep ?? findings.map((f) => textOf(f, 'code'));
    const groups = groupFindings(findings);
    const keepFor = (code: string) => (registered
        ? null
        : { on: kept.includes(code), onChange: (on: boolean) => setKeep(on ? [...kept, code] : kept.filter((c) => c !== code)) });
    const row = (f: Record<string, unknown>) => <FindingRow key={textOf(f, 'code')} finding={f} keep={keepFor(textOf(f, 'code'))} />;
    return (
        <>
            <Verdict playbook={playbook} phase={phase} />
            {findings.length === 0 ? (
                <Text variant="caption" tone="secondary">
                    {t('playbooks.compliance.clean', 'Nothing came up. What was built does not touch the rules you have switched on.')}
                </Text>
            ) : null}
            {[...groups.high, ...groups.medium].map(row)}
            {groups.low.length ? (
                <Button
                    size="sm"
                    variant="ghost"
                    label={groups.low.length === 1 ? t('playbooks.compliance.notes_one', '1 note, good to know') : t('playbooks.compliance.notes', '{n} notes, good to know', { n: groups.low.length })}
                    onPress={() => setShowLow((v) => !v)}
                />
            ) : null}
            {showLow ? groups.low.map(row) : null}
            {facts && artRecord(facts, 'table') ? (
                <RegisterPanel facts={facts} registered={registered} busy={register.isPending} error={register.error} refused={failedLine(register.data?.failed)} onRegister={(reg) => register.mutate(registrationBody(reg, kept))} />
            ) : null}
            <Text variant="label" tone="tertiary">
                {t('playbooks.compliance.disclaimer', 'A reading of what was built, not legal advice — and the review itself changed nothing.')}
            </Text>
        </>
    );
}

export function ComplianceStage({ playbook, phase }: { playbook: Playbook; phase: Phase }) {
    const t = useTranslation();
    const frameworks = (artList(phase.artifacts, 'frameworks') ?? []).filter((f): f is string => typeof f === 'string');
    const landed = phase.status === 'awaiting' || phase.status === 'done';
    return (
        <StageCard
            kind="compliance"
            title={t('playbooks.compliance.title', 'Checked against your frameworks')}
            status={statusLine(phase, frameworks, t)}
            tone={phase.status === 'failed' ? 'error' : landed ? 'quiet' : 'busy'}
            testID="playbook-stage-compliance"
        >
            {landed ? <Landed playbook={playbook} phase={phase} /> : null}
        </StageCard>
    );
}

const makeStyles = (theme: Theme) => ({
    verdict: { gap: theme.spacing[1.5] },
});
