import type { ComponentType } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import BucketForm from './ops/BucketForm';
import DeriveForm from './ops/DeriveForm';
import DescribeForm from './ops/DescribeForm';
import FilterForm from './ops/FilterForm';
import GroupForm from './ops/GroupForm';
import GroupsForm from './ops/GroupsForm';
import { TextInput } from './ops/inputs';
import JoinForm from './ops/JoinForm';
import OpField from './ops/OpField';
import type { OpContext, OpFormProps } from './ops/opFormTypes';
import PivotForm from './ops/PivotForm';
import PseudonymiseForm from './ops/PseudonymiseForm';
import SampleForm from './ops/SampleForm';
import SelectForm from './ops/SelectForm';
import type { OpKind, TableOp } from './tableOpModel';

type AnyForm = ComponentType<OpFormProps<never>>;

const FORMS: Record<OpKind, AnyForm> = {
    join: JoinForm as unknown as AnyForm,
    pseudonymise: PseudonymiseForm as unknown as AnyForm,
    derive: DeriveForm as unknown as AnyForm,
    bucket: BucketForm as unknown as AnyForm,
    group: GroupForm as unknown as AnyForm,
    pivot: PivotForm as unknown as AnyForm,
    filter: FilterForm as unknown as AnyForm,
    select: SelectForm as unknown as AnyForm,
    sample: SampleForm as unknown as AnyForm,
    groups: GroupsForm as unknown as AnyForm,
    describe: DescribeForm as unknown as AnyForm,
};

interface Props { op: TableOp; onChange: (next: TableOp) => void; ctx: OpContext }

/** The form of one operation: its own settings, then a note for whoever reads this step later. */
export default function TableOpForm({ op, onChange, ctx }: Props) {
    const { t } = useTranslation();
    const Form = FORMS[op.op] as unknown as ComponentType<OpFormProps<TableOp>>;
    if (!Form) return null;
    return (
        <div className="flex flex-col gap-3" data-testid={`op-form-${op.op}`}>
            <p className="text-[11px] text-[var(--text-secondary)]">{ctx.help.ops[op.op].blurb}</p>
            <Form op={op} onChange={onChange} ctx={ctx} />
            <OpField ctx={ctx} name="note" label={t('automation_tables.op.note', 'Note')} help={ctx.help.note}>
                {id => (
                    <TextInput
                        id={id} value={op.note ?? ''} ariaLabel={t('automation_tables.op.note', 'Note')}
                        onChange={note => { const next = { ...op }; if (note) next.note = note; else delete next.note; onChange(next); }}
                    />
                )}
            </OpField>
        </div>
    );
}
