/**
 * "How many outputs does this node have?" — the up-front choice (BFSF-356)
 * the web's RouteFields opens with (routeEditorsOutputs.tsx): one output
 * lets what matches continue, several each have their own rule and way on. The consequences are said where
 * the choice is made — how several outputs share a record, what a rename and
 * a removal do on the canvas — and going back to one asks first when an
 * output it would remove is wired. What matches no output is told as one
 * "Otherwise" story (O2); with one output in list mode the author can send it
 * to “Otherwise” instead of dropping it (BFSF-485 F2).
 */

import React from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { ToggleField } from '@/features/flow-editor/components/fields';
import type { Route } from '@/features/flow-editor/model';
import { useConfirm } from '@/shared/patterns';
import { Segmented } from '@/shared/ui';

import { chooseSeveral, collapseToOne, keepRestPatch, losingOutputs, type OutputName, type RoutePatch } from './routeEdits';
import { Note } from '../shared/Note';

export interface OutputsChooserProps {
    route: Route;
    wired: ReadonlySet<string>;
    setRoute: (patch: RoutePatch) => void;
    disabled?: boolean;
}

/** O3: "Output 1", "Output 2", … */
export function outputNamer(t: TranslateFn): OutputName {
    return (n) => t('condition_node.default_output_name', 'Output {n}', { n });
}

export interface OtherwiseCase {
    several: boolean;
    fanOut: boolean;
    keepRest: boolean;
    /** List mode; a whole-run Condition decides once, then or else, so it never "stops the rest". */
    items: boolean;
}

/** O2: the one sentence about what happens to what matches no output. */
export function otherwiseSentence(t: TranslateFn, { several, fanOut, keepRest, items }: OtherwiseCase): string {
    if (several && fanOut) {
        return t('condition_node.otherwise.all', 'Each output is checked on its own, so one item can go down several outputs. What matches no output goes to “Otherwise”; leave “Otherwise” unconnected to drop it.');
    }
    if (several) {
        return t('condition_node.otherwise.first', 'Each item takes the first output it matches. What matches no output goes to “Otherwise”; leave “Otherwise” unconnected to drop it.');
    }
    if (!items) return t('condition_node.otherwise.one_run', 'When the rule holds, the run continues; when it doesn’t, the run goes to “Otherwise”; leave “Otherwise” unconnected to stop it there.');
    if (keepRest) return t('condition_node.otherwise.one_keep', 'What matches continues; what doesn\'t goes to “Otherwise”; leave “Otherwise” unconnected to drop it.');
    return t('condition_node.otherwise.one', 'What matches continues; the rest stops here.');
}

/**
 * "This node has 3 outputs." — and with a live “Otherwise” (keep-rest on, or
 * the else port of a whole-run Condition) its one output plus “Otherwise”.
 */
export function outputCount(t: TranslateFn, count: number, withOtherwise: boolean): string {
    if (count > 1) return t('condition_node.outputs.count', 'This node has {n} outputs.', { n: count });
    if (withOtherwise) return t('condition_node.outputs.count_one_keep', 'This node has 1 output plus “Otherwise”.');
    return t('condition_node.outputs.count_one', 'This node has 1 output.');
}

export function OutputsChooser({ route, wired, setRoute, disabled = false }: OutputsChooserProps) {
    const t = useTranslation();
    const confirm = useConfirm();
    const count = route.rules.length;
    const several = count > 1;
    const items = route.mode === 'items';
    const outputName = outputNamer(t);
    const chooseOne = async () => {
        if (!several) return;
        const losing = losingOutputs(route, wired);
        if (losing.length) {
            const outputs = losing.join(', ');
            const ok = await confirm({
                title: t('mobile.flow.route.collapse_title', 'Go back to one output?'),
                message: losing.length === 1
                    ? t('condition_node.collapse.one', 'Going back to one output removes {outputs}. That output is wired on the canvas, so its connection goes too.', { outputs })
                    : t('condition_node.collapse.several', 'Going back to one output removes {outputs}. Those outputs are wired on the canvas, so their connections go too.', { outputs }),
                confirmLabel: t('condition_node.collapse.confirm', 'Remove them anyway'),
            });
            if (!ok) return;
        }
        setRoute(collapseToOne(route));
    };
    const choose = (next: string) => {
        if (next === 'one') void chooseOne();
        else {
            const patch = chooseSeveral(route, outputName);
            if (patch) setRoute(patch);
        }
    };
    const fanOut = route.matchMode === 'all';
    const keepRest = items && !several && !!route.keepRest;
    return (
        <>
            <Segmented
                value={several ? 'several' : 'one'}
                onChange={choose}
                options={[
                    { value: 'one', label: t('condition_node.outputs.one', 'One output'), disabled },
                    { value: 'several', label: t('condition_node.outputs.several', 'Several outputs'), disabled },
                ]}
                accessibilityLabel={t('condition_node.outputs.aria', 'Number of outputs')}
                fullWidth
            />
            <Note>{t('condition_node.outputs.hint', 'One output: what matches continues. Several outputs: each has its own rule and its own way on.')}</Note>
            <Note>{outputCount(t, count, !items || keepRest)}</Note>
            {items && !several && route.style !== 'value' ? (
                <ToggleField
                    value={keepRest}
                    onChange={(on) => setRoute(keepRestPatch(route, on, outputName))}
                    label={t('condition_node.outputs.keep_rest', 'Send what doesn\'t match to “Otherwise”')}
                    description={t('condition_node.outputs.keep_rest_hint', 'Otherwise becomes a second output; leave it unconnected to drop those items.')}
                    disabled={disabled}
                    testID="route-keep-rest"
                />
            ) : null}
            <Note>{otherwiseSentence(t, { several, fanOut, keepRest, items })}</Note>
            {/* Said where it applies: with one output there is no Output 2. */}
            {several ? (
                <>
                    <Note>
                        {t(
                            'condition_node.outputs.example',
                            'Each output is a filter with its own destination. For example, Output 1: Subject contains urgent; Output 2: Subject contains invoice.',
                        )}
                    </Note>
                    <Note>{t('condition_node.outputs.canvas_note', 'On the canvas: an output that keeps its name keeps its connection, an output that disappears takes its connection with it.')}</Note>
                </>
            ) : null}
        </>
    );
}
