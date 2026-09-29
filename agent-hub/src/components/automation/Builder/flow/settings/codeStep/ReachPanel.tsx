// "What this step may reach", read off the code.
//
// The sentence the engine could never say: a code step's outbound reach is
// real (an HTTPS fetch, a call into a connected app through the user's own
// permissions) and used to be invisible to everyone but whoever wrote the
// snippet, usually an AI. The floor line is unconditional, so "this step
// reaches nothing" is a statement the author reads rather than an absence.
//
// Every claim mirrors server/automation/codeSandbox.js and the runner's
// execCode. If those change, this is the text that has to change with them.
import { AlertTriangle, Globe, KeyRound, Lock, Plug, ScrollText, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import { hintTextClass, subLabelClass } from '../formPrimitives';
import type { CodeContract } from './readCodeContract';

function ReachLine({ icon: Icon, tone = 'info', children }: { icon: LucideIcon; tone?: 'info' | 'warn'; children: ReactNode }) {
    return (
        <li className={`flex items-start gap-1.5 ${hintTextClass()} ${tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : ''}`}>
            <Icon size={12} className="shrink-0 mt-0.5 opacity-80" aria-hidden="true" />
            <span className="min-w-0">{children}</span>
        </li>
    );
}

function InputsLine({ contract, inputsEditable }: { contract: CodeContract; inputsEditable: boolean }) {
    const { t } = useTranslation();
    const { inputNames, computedInputs } = contract;
    let body: ReactNode;
    if (inputNames.length > 0) {
        body = (
            <>
                {t('code_step.reach.reads_inputs', 'Reads these step inputs:')} <span className="font-mono">{inputNames.join(', ')}</span>
                {computedInputs ? t('code_step.reach.and_more', ', and more, looked up by a name this panel cannot read.') : '.'}
            </>
        );
    } else {
        body = computedInputs
            ? t('code_step.reach.reads_computed', 'Reads step inputs by a name this panel cannot read.')
            : t('code_step.reach.reads_none', 'Reads no step inputs.');
    }
    const unsettable = !inputsEditable && (inputNames.length > 0 || computedInputs);
    return (
        <ReachLine icon={KeyRound}>
            {body}
            {unsettable && ` ${t('code_step.reach.inputs_unsettable', 'They come from the step\'s own inputs, which this editor cannot set yet. The AI that wrote this step does.')}`}
        </ReachLine>
    );
}

export default function ReachPanel({ contract, inputsEditable }: { contract: CodeContract; inputsEditable: boolean }) {
    const { t } = useTranslation();
    const { toolNames, usesHttp, usesSecrets, usesLog } = contract;
    const reachesOut = usesHttp || toolNames.length > 0;
    return (
        <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-2.5 py-2 space-y-1.5">
            <div className={subLabelClass()}>{t('code_step.reach.title', 'What this step may reach')}</div>
            <ul className="space-y-1">
                <ReachLine icon={Lock}>
                    {t('code_step.reach.sandbox', 'A sandbox of its own: no files, no Node, no network of its own.')}
                    {reachesOut ? ` ${t('code_step.reach.ways_out', 'The lines below are the ways out this code does use.')}` : ''}
                </ReachLine>
                <InputsLine contract={contract} inputsEditable={inputsEditable} />
                {usesHttp && (
                    <ReachLine icon={Globe}>
                        {t('code_step.reach.http', 'The web, over ctx.http(): HTTPS only, never a private or internal address, 5 calls per run and 10 seconds each.')}
                    </ReachLine>
                )}
                {toolNames.length > 0 && (
                    <ReachLine icon={Plug}>
                        {t('code_step.reach.tools', 'Connected apps:')} <span className="font-mono">{toolNames.join(', ')}</span>.{' '}
                        {t('code_step.reach.tools_refused', 'Each call is refused at run time unless this step is allowed to use that app and you still hold that permission.')}
                    </ReachLine>
                )}
                {usesLog && (
                    <ReachLine icon={ScrollText}>
                        {t('code_step.reach.log', 'Writes to the run log with ctx.log(), where anyone who can see this run can read it.')}
                    </ReachLine>
                )}
                {usesSecrets && (
                    <ReachLine icon={AlertTriangle} tone="warn">
                        {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- copy that explains ctx.secrets(), not a secret */}
                        {t('code_step.reach.secrets', 'ctx.secrets() is not wired in this build: every call throws, and a step that declares secretKeys refuses to run at all. Pass the value in as a step input, or use a connected app that carries its own credentials.')}
                    </ReachLine>
                )}
            </ul>
        </div>
    );
}
