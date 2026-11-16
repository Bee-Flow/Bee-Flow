import useTranslation from '@/hooks/useTranslation';
import { blockEntries } from '../../runtime/components/customBlock/blockHost';
import { registerInspector } from '../registry';
import type { PanelProps } from '../appDefinition';

/**
 * react_block (spec: server/appStudio/componentSpecs/types/react_block.js): what the block is,
 * read only. The builder writes and compiles it (app_edit_react_block); the panel shows whether
 * it compiles, its source, and the names of its inputs and wired events.
 */

interface ReactBlockValue {
    source?: unknown;
    inputs?: unknown;
    events?: unknown;
    compiled?: unknown;
    compileError?: unknown;
}

const HINT = 'text-[11px] text-[var(--text-tertiary)]';
const LABEL = 'text-xs font-medium text-[var(--text-secondary)]';
const CODE = 'max-h-64 overflow-auto whitespace-pre rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 py-1.5 font-mono text-[11px] leading-snug text-[var(--text-primary)]';

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

function Names({ label, names, none }: { label: string; names: string[]; none: string }) {
    return (
        <div className="flex flex-col gap-1">
            <span className={LABEL}>{label}</span>
            <span className="font-mono text-xs text-[var(--text-primary)]">{names.length ? names.join(', ') : none}</span>
        </div>
    );
}

export default function ReactBlockPanel({ node }: PanelProps<{ block?: ReactBlockValue | null }>) {
    const { t } = useTranslation();
    const block: ReactBlockValue = node.props?.block && typeof node.props.block === 'object' ? node.props.block : {};
    const source = textOf(block.source);
    const compiled = textOf(block.compiled) !== '';
    const error = textOf(block.compileError);
    const wired = blockEntries(block.events).filter(([, id]) => typeof id === 'string' && id).map(([name]) => name);
    const none = t('studio_apps_react_block.none', 'none');
    return (
        <div className="flex flex-col gap-3" data-react-block-panel="true">
            <p className={HINT}>{t('studio_apps_react_block.panel_hint', 'The builder writes this component and compiles it on every save. Ask it in the chat to change the block.')}</p>
            <p className="text-xs text-[var(--text-primary)]" role="status">
                {compiled ? t('studio_apps_react_block.compiled', 'Compiles.') : t('studio_apps_react_block.not_compiled', 'This React block does not compile yet.')}
            </p>
            {!compiled && error ? <pre className={`${CODE} text-[var(--error-ink)]`}>{error}</pre> : null}
            <div className="flex flex-col gap-1">
                <span className={LABEL}>{t('studio_apps_react_block.source', 'Source')}</span>
                <pre className={CODE}>{source || none}</pre>
            </div>
            <Names label={t('studio_apps_react_block.inputs', 'Inputs')} names={blockEntries(block.inputs).map(([name]) => name)} none={none} />
            <Names label={t('studio_apps_react_block.events', 'Wired events')} names={wired} none={none} />
        </div>
    );
}

registerInspector('react_block', ReactBlockPanel, { props: ['block'] });
