/**
 * "How many outputs does this node have?" — the up-front choice (BFSF-356)
 * the web's RouteFields opens with: one output filters (what matches
 * continues, the rest stops), several route. The consequences are said where
 * the choice is made — how several outputs share a record, what a rename and
 * a removal do on the canvas — and going back to one asks first when an
 * output it would remove is wired.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import type { Route } from '@/features/flow-editor/model';
import { useConfirm } from '@/shared/patterns';
import { Segmented } from '@/shared/ui';

import { chooseSeveral, collapseToOne, losingOutputs, type RoutePatch } from './routeEdits';
import { Note } from '../shared/Note';

export interface OutputsChooserProps {
    route: Route;
    wired: ReadonlySet<string>;
    setRoute: (patch: RoutePatch) => void;
    disabled?: boolean;
}

export function OutputsChooser({ route, wired, setRoute, disabled = false }: OutputsChooserProps) {
    const t = useTranslation();
    const confirm = useConfirm();
    const count = route.rules.length;
    const several = count > 1;
    const items = route.mode === 'items';
    const chooseOne = async () => {
        if (!several) return;
        const losing = losingOutputs(route, wired);
        if (losing.length) {
            const ok = await confirm({
                title: t('mobile.flow.route.collapse_title', 'Go back to one output?'),
                message: t('mobile.flow.route.collapse_message', 'Going back to one output removes {outputs} — wired on the canvas, so the connections go too.', {
                    outputs: losing.map((l) => t('mobile.flow.route.output_named', 'Output {letter} ({name})', l)).join(', '),
                }),
                confirmLabel: t('mobile.flow.route.collapse_confirm', 'Remove them anyway'),
            });
            if (!ok) return;
        }
        setRoute(collapseToOne(route));
    };
    const choose = (next: string) => {
        if (next === 'one') void chooseOne();
        else {
            const patch = chooseSeveral(route);
            if (patch) setRoute(patch);
        }
    };
    const fanOut = route.matchMode === 'all';
    const unit = items ? t('mobile.flow.route.an_item', 'an item') : t('mobile.flow.route.a_record', 'a record');
    return (
        <>
            <Segmented
                value={several ? 'several' : 'one'}
                onChange={choose}
                options={[
                    { value: 'one', label: t('mobile.flow.route.one_output', 'One output'), disabled },
                    { value: 'several', label: t('mobile.flow.route.several_outputs', 'Several outputs'), disabled },
                ]}
                accessibilityLabel={t('mobile.flow.route.how_many', 'How many outputs does this node have?')}
                fullWidth
            />
            <Note>{t('mobile.flow.route.how_many_hint', 'One output filters: what matches continues, the rest stops here. Several outputs route.')}</Note>
            <Note>
                {several
                    ? t('mobile.flow.route.has_n_outputs', 'This node has {n} outputs.', { n: count })
                    : t('mobile.flow.route.has_one_output', 'This node has 1 output.')}
            </Note>
            <Note>
                {t(
                    'mobile.flow.route.example',
                    'Each output is a filter with its own destination — for example Output A: Subject contains urgent, Output B: Subject contains invoice.',
                )}
            </Note>
            {several ? (
                <Note>
                    {fanOut
                        ? t(
                              'mobile.flow.route.fan_out',
                              'Every output is checked on its own, so {unit} that matches two outputs travels both paths. Whatever matches no output at all is dropped here — it stays counted as rejected.',
                              { unit },
                          )
                        : t(
                              'mobile.flow.route.first_match',
                              'Each one takes the FIRST output it matches and no other. Whatever matches no output at all is dropped here. Change this under Advanced.',
                          )}
                </Note>
            ) : null}
            {several ? (
                <Note>{t('mobile.flow.route.canvas_note', 'On the canvas: an output that keeps its name keeps its connection, an output that disappears takes its connection with it.')}</Note>
            ) : null}
        </>
    );
}
