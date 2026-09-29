// One line that says what this step can reach, from the server's reading of
// the code: "Can send data to api.example.com and use Gmail: send." The
// promise a non-programmer needs before running someone else's code.
import { ShieldCheck } from 'lucide-react';
import type { CodeCapabilities } from '../../../../../../api/queries/automation/codeStep';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import { hintTextClass } from '../formPrimitives';
import { toolLabel } from './codeParams';

export function useCapabilitySentence(caps: CodeCapabilities | null | undefined, allowedHosts: string[] = []): string | null {
    const { t } = useTranslation();
    if (!caps) return null;
    const parts: string[] = [];
    const hosts = [...new Set([...caps.hosts, ...(caps.dynamicHosts ? allowedHosts : [])])];
    if (hosts.length) parts.push(t('code_step.cap.send_to', 'send data to {hosts}', { hosts: hosts.join(', ') }));
    if (caps.dynamicHosts && !allowedHosts.length) parts.push(t('code_step.cap.send_anywhere', 'send data to addresses it works out while running'));
    if (caps.tools.length) parts.push(t('code_step.cap.use_tools', 'use {tools}', { tools: caps.tools.map(toolLabel).join(', ') }));
    if (!parts.length) return t('code_step.cap.nothing', 'Reaches nothing outside Bee Flow: it only works with the values it is given.');
    return t('code_step.cap.line', 'Can {things}.', { things: parts.join(` ${t('code_step.cap.and', 'and')} `) });
}

export default function CapabilityLine({ caps, allowedHosts = [] }: { caps: CodeCapabilities | null | undefined; allowedHosts?: string[] }) {
    const sentence = useCapabilitySentence(caps, allowedHosts);
    if (!sentence) return null;
    return (
        <p className={`flex items-start gap-1.5 ${hintTextClass()}`} data-testid="code-capability-line">
            <ShieldCheck size={12} className="shrink-0 mt-0.5 opacity-80" aria-hidden="true" />
            <span className="min-w-0">{sentence}</span>
        </p>
    );
}
