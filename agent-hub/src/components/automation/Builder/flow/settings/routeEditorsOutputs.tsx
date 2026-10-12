/**
 * "How many outputs does this node have?" — the up-front choice of the
 * Condition editor (BFSF-356), drawn with the shared SegmentedControl (O1),
 * with one "Otherwise" story told in one sentence (O2) and, for one output
 * in list mode, the box that sends what doesn't match to “Otherwise”
 * instead of dropping it (BFSF-485 F2). RouteFields owns the state; this only
 * shows it and reports the clicks.
 */
import SegmentedControl from '../../../../shared/SegmentedControl';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { FormRow } from './formPrimitives';

type Count = 'one' | 'several';
type Translate = ReturnType<typeof useTranslation>['t'];

// O1: the shared control draws its selected pill in --bg-card on --bg-tertiary,
// which in the dark theme are a shade apart; a ring and the bolder weight make
// the chosen option readable in both themes.
const SELECTED_RING = '*:aria-checked:!shadow-[inset_0_0_0_1px_var(--text-tertiary)] *:aria-checked:!font-semibold';

export interface OutputsChooserProps {
    ruleCount: number;
    fanOut: boolean;
    /** List mode: the keep-rest box is offered with one output. */
    items: boolean;
    keepRest: boolean;
    /** False on a legacy value-style switch, which has no one-output form. */
    canKeepRest: boolean;
    onChoose: (next: Count) => void;
    onKeepRest: (on: boolean) => void;
    /** The wired outputs a collapse to one would cost, while it waits for a yes. */
    collapseAsk: string[] | null;
    onConfirmCollapse: () => void;
    onCancelCollapse: () => void;
}

/**
 * The one sentence about what happens to what matches no output. A whole-run
 * Condition decides once for the run, then or else, so "the rest stops here"
 * (a filter's sentence) would be wrong there.
 */
function otherwiseText(t: Translate, { several, fanOut, keepRest, items }: { several: boolean; fanOut: boolean; keepRest: boolean; items: boolean }): string {
    if (several) {
        return fanOut
            ? t('condition_node.otherwise.all', 'Each output is checked on its own, so one item can go down several outputs. What matches no output goes to “Otherwise”; leave “Otherwise” unconnected to drop it.')
            : t('condition_node.otherwise.first', 'Each item takes the first output it matches. What matches no output goes to “Otherwise”; leave “Otherwise” unconnected to drop it.');
    }
    if (!items) return t('condition_node.otherwise.one_run', 'When the rule holds, the run continues; when it doesn’t, the run goes to “Otherwise”; leave “Otherwise” unconnected to stop it there.');
    return keepRest
        ? t('condition_node.otherwise.one_keep', 'What matches continues; what doesn\'t goes to “Otherwise”; leave “Otherwise” unconnected to drop it.')
        : t('condition_node.otherwise.one', 'What matches continues; the rest stops here.');
}

function CollapseAsk({ names, onConfirm, onCancel }: { names: string[]; onConfirm: () => void; onCancel: () => void }) {
    const { t } = useTranslation();
    const outputs = names.join(', ');
    return (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 space-y-1.5">
            <div className="text-[10px] text-[var(--text-primary)]">
                {names.length === 1
                    ? t('condition_node.collapse.one', 'Going back to one output removes {outputs}. That output is wired on the canvas, so its connection goes too.', { outputs })
                    : t('condition_node.collapse.several', 'Going back to one output removes {outputs}. Those outputs are wired on the canvas, so their connections go too.', { outputs })}
            </div>
            <div className="flex gap-2">
                <button type="button" onClick={onConfirm} className="text-[10px] text-red-500 hover:underline">
                    {t('condition_node.collapse.confirm', 'Remove them anyway')}
                </button>
                <button type="button" onClick={onCancel} className="text-[10px] text-[var(--text-tertiary)] hover:underline">
                    {t('condition_node.collapse.cancel', 'Keep several outputs')}
                </button>
            </div>
        </div>
    );
}

function KeepRestBox({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
    const { t } = useTranslation();
    return (
        <label className="flex items-start gap-1.5 text-[11px] text-[var(--text-primary)]">
            <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" />
            <span>
                {t('condition_node.outputs.keep_rest', 'Send what doesn\'t match to “Otherwise”')}
                <span className="block text-[10px] text-[var(--text-tertiary)]">
                    {t('condition_node.outputs.keep_rest_hint', 'Otherwise becomes a second output; leave it unconnected to drop those items.')}
                </span>
            </span>
        </label>
    );
}

/**
 * How many outputs, as the canvas card counts them: a kept rest is a live
 * "Otherwise", and so is the else port of a whole-run Condition.
 */
function countText(t: Translate, ruleCount: number, withOtherwise: boolean): string {
    if (ruleCount > 1) return t('condition_node.outputs.count', 'This node has {n} outputs.', { n: ruleCount });
    if (withOtherwise) return t('condition_node.outputs.count_one_keep', 'This node has 1 output plus “Otherwise”.');
    return t('condition_node.outputs.count_one', 'This node has 1 output.');
}

export function OutputsChooser(props: OutputsChooserProps) {
    const { ruleCount, fanOut, items, keepRest, canKeepRest, onChoose, onKeepRest, collapseAsk } = props;
    const { t } = useTranslation();
    const several = ruleCount > 1;
    return (
        <FormRow
            label={t('condition_node.outputs.label', 'How many outputs does this node have?')}
            hint={t('condition_node.outputs.hint', 'One output: what matches continues. Several outputs: each has its own rule and its own way on.')}
        >
            <div className="space-y-1.5">
                <SegmentedControl
                    size="sm"
                    value={several ? 'several' : 'one'}
                    onChange={onChoose}
                    ariaLabel={t('condition_node.outputs.aria', 'Number of outputs')}
                    className={SELECTED_RING}
                    options={[
                        { value: 'one', label: t('condition_node.outputs.one', 'One output') },
                        { value: 'several', label: t('condition_node.outputs.several', 'Several outputs') },
                    ]}
                />
                <div className="text-[11px] text-[var(--text-secondary)]">
                    {/* An unconfigured node has no rules yet but still routes
                        everything down one path, so "0 outputs" next to a
                        selected "One output" contradicts itself. */}
                    {countText(t, ruleCount, !items || keepRest)}
                </div>
                {items && !several && canKeepRest && <KeepRestBox checked={keepRest} onChange={onKeepRest} />}
                <div className="text-[10px] text-[var(--text-tertiary)]">{otherwiseText(t, { several, fanOut, keepRest: keepRest && items, items })}</div>
                {/* There is no documentation for this node anywhere, so the
                    editor is the only place the shape can be learned — said
                    where it applies: with one output there is no Output 2. */}
                {several && (
                    <div className="text-[10px] text-[var(--text-tertiary)]">
                        {t('condition_node.outputs.example', 'Each output is a filter with its own destination. For example, Output 1: Subject contains urgent; Output 2: Subject contains invoice.')}
                    </div>
                )}
                {several && (
                    <div className="text-[10px] text-[var(--text-tertiary)]">
                        {t('condition_node.outputs.canvas_note', 'On the canvas: an output that keeps its name keeps its connection, an output that disappears takes its connection with it.')}
                    </div>
                )}
                {collapseAsk && <CollapseAsk names={collapseAsk} onConfirm={props.onConfirmCollapse} onCancel={props.onCancelCollapse} />}
            </div>
        </FormRow>
    );
}
