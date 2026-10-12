/**
 * Test harness for the Condition editor (RouteFields): holds the draft the
 * way SettingsForm does and reports every route edit as the step fields
 * writeRoute would save, so a test reads what lands in the automation.
 * Demo data is invented (Fabrikam / Contoso).
 */
import { render } from '@testing-library/react';
import { useState, type ComponentType } from 'react';
import { VariablePickerProvider } from '../../mapping/VariablePickerContext';
import { writeRoute } from '../routeModel';
import { RouteFields as RouteFieldsJs } from './routeEditors';
import type { RouteFollow, WholeRun } from './SourceNotices';

// routeEditors.jsx is untyped: its `= null` defaults would type those props as `null`.
const RouteFields = RouteFieldsJs as unknown as ComponentType<Record<string, unknown>>;

export const MAILS = [
    {
        subject: 'Invoice 1042', from: 'billing@fabrikam.example',
        attachments: [
            { filename: 'invoice-1042.pdf', mimeType: 'application/pdf' },
            { filename: 'logo.png', mimeType: 'image/png' },
        ],
    },
    {
        subject: 'Minutes', from: 'office@contoso.example',
        attachments: [{ filename: 'minutes.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }],
    },
];

export const MAIL_GROUP = {
    id: 'm', label: 'Read many', kind: 'integration_action', basePath: 'steps.m.output',
    sample: { messages: MAILS },
    fields: [{ key: 'messages', path: 'steps.m.output.messages', sample: MAILS }],
};
export const MAIL_ROOT = { steps: { m: { output: { messages: MAILS } } } };

type Step = Record<string, unknown> & { id: string; type: string };
type Saved = Record<string, unknown>;

interface HarnessProps {
    step: Step;
    onSave: (fields: Saved) => void;
    groups: unknown[];
    previewSample: unknown;
    routeFollow?: RouteFollow | null;
    wholeRun?: WholeRun | null;
    wiredCaseNames?: Set<string> | null;
}

function Harness({ step, onSave, groups, previewSample, routeFollow = null, wholeRun = null, wiredCaseNames = null }: HarnessProps) {
    const [draft, setDraft] = useState<Record<string, unknown>>({});
    const set = (key: string, value: unknown) => {
        setDraft((d) => ({ ...d, [key]: value }));
        if (key === 'route') onSave(writeRoute(value));
    };
    return (
        <VariablePickerProvider groups={groups} previewSample={previewSample} stepLabelById={new Map([['m', 'Read many']])} stepTypeById={new Map()}>
            <RouteFields
                step={step} draft={draft} set={set} groups={groups}
                onFocusField={null} previewSample={previewSample}
                wiredCaseNames={wiredCaseNames} routeFollow={routeFollow} wholeRun={wholeRun}
            />
        </VariablePickerProvider>
    );
}

/** Render the editor for `step`; `saved()` is the last route edit as step fields. */
export function renderRoute(step: Step, opts: Partial<Omit<HarnessProps, 'step' | 'onSave'>> = {}) {
    const saves: Saved[] = [];
    const utils = render(
        <Harness
            step={step}
            onSave={(f) => saves.push(f)}
            groups={opts.groups ?? [MAIL_GROUP]}
            previewSample={opts.previewSample ?? MAIL_ROOT}
            routeFollow={opts.routeFollow ?? null}
            wholeRun={opts.wholeRun ?? null}
            wiredCaseNames={opts.wiredCaseNames ?? null}
        />,
    );
    return { ...utils, saves, saved: () => saves[saves.length - 1] };
}
