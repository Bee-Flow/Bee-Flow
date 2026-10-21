import { useTranslation } from '../../../../../../../hooks/useTranslation';
import { ColumnSelect } from '../TableColumnSelect';
import type { Band, BucketOp } from '../tableOpModel';
import { AddButton, ListInput, NumberInput, Radios, Row, TextInput } from './inputs';
import type { OpFormProps } from './opFormTypes';
import OpField from './OpField';

type Mapping = BucketOp['map'][number];

function BandRows({ op, set, ctx }: Pick<OpFormProps<BucketOp>, 'ctx'> & { op: BucketOp; set: (p: Partial<BucketOp>) => void }) {
    const { t } = useTranslation();
    const edit = (i: number, patch: Partial<Band>) => set({ bands: op.bands.map((b, j) => (j === i ? { ...b, ...patch } : b)) });
    return (
        <OpField ctx={ctx} name="bands" exact label={t('automation_tables.bucket.bands', 'Bands')} help={ctx.help.bucket.bands}>
            <div className="flex flex-col gap-1.5">
                {op.bands.map((b, i) => (
                    <Row key={i} onRemove={op.bands.length > 1 ? () => set({ bands: op.bands.filter((_, j) => j !== i) }) : undefined} removeLabel={t('automation_tables.bucket.remove_band', 'Remove this band')}>
                        <OpField ctx={ctx} name={`bands[${i}].label`} label={t('automation_tables.bucket.band_label', 'Name of the band')}>
                            {id => <TextInput id={id} value={b.label} onChange={label => edit(i, { label })} ariaLabel={t('automation_tables.bucket.band_label', 'Name of the band')} />}
                        </OpField>
                        <div className="grid grid-cols-2 gap-2">
                            <OpField ctx={ctx} name={`bands[${i}].min`} label={t('automation_tables.bucket.from', 'From (including)')}>
                                {id => <NumberInput id={id} value={b.min} onChange={min => edit(i, { min })} ariaLabel={t('automation_tables.bucket.from', 'From (including)')} />}
                            </OpField>
                            <OpField ctx={ctx} name={`bands[${i}].max`} label={t('automation_tables.bucket.to', 'Up to (not including)')}>
                                {id => <NumberInput id={id} value={b.max} onChange={max => edit(i, { max })} ariaLabel={t('automation_tables.bucket.to', 'Up to (not including)')} />}
                            </OpField>
                        </div>
                    </Row>
                ))}
                <AddButton onClick={() => set({ bands: [...op.bands, { label: '', min: null, max: null }] })}>{t('automation_tables.bucket.add_band', 'Add a band')}</AddButton>
            </div>
        </OpField>
    );
}

function ValueRows({ op, set, ctx }: Pick<OpFormProps<BucketOp>, 'ctx'> & { op: BucketOp; set: (p: Partial<BucketOp>) => void }) {
    const { t } = useTranslation();
    const edit = (i: number, patch: Partial<Mapping>) => set({ map: op.map.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
    return (
        <OpField ctx={ctx} name="map" exact label={t('automation_tables.bucket.map', 'Values that belong together')} help={ctx.help.bucket.map}>
            <div className="flex flex-col gap-1.5">
                {op.map.map((m, i) => (
                    <Row key={i} onRemove={() => set({ map: op.map.filter((_, j) => j !== i) })} removeLabel={t('automation_tables.bucket.remove_map', 'Remove this group of values')}>
                        <OpField ctx={ctx} name={`map[${i}].values`} label={t('automation_tables.bucket.map_values', 'Values')}>
                            {id => <ListInput id={id} value={m.values.map(String)} onChange={values => edit(i, { values })} ariaLabel={t('automation_tables.bucket.map_values', 'Values')} placeholder={t('automation_tables.bucket.map_placeholder', 'Separate with commas')} />}
                        </OpField>
                        <OpField ctx={ctx} name={`map[${i}].label`} label={t('automation_tables.bucket.map_label', 'Label')}>
                            {id => <TextInput id={id} value={m.label} onChange={label => edit(i, { label })} ariaLabel={t('automation_tables.bucket.map_label', 'Label')} />}
                        </OpField>
                    </Row>
                ))}
                <AddButton onClick={() => set({ map: [...op.map, { values: [], label: '' }] })}>{t('automation_tables.bucket.add_map', 'Add a group of values')}</AddButton>
            </div>
        </OpField>
    );
}

export default function BucketForm({ op, onChange, ctx }: OpFormProps<BucketOp>) {
    const { t } = useTranslation();
    const h = ctx.help.bucket;
    const set = (patch: Partial<BucketOp>) => onChange({ ...op, ...patch });
    return (
        <div className="flex flex-col gap-3">
            <OpField ctx={ctx} name="column" label={t('automation_tables.bucket.column', 'Column')} help={h.column}>
                {id => <ColumnSelect id={id} value={op.column} onChange={column => set({ column })} columns={ctx.columns} described={ctx.described} prefer={op.mode === 'values' ? 'split' : 'numeric'} ariaLabel={t('automation_tables.bucket.column', 'Column')} />}
            </OpField>
            <OpField ctx={ctx} name="output" label={t('automation_tables.bucket.output', 'Name of the new column')} help={h.output}>
                {id => <TextInput id={id} value={op.output} onChange={output => set({ output })} ariaLabel={t('automation_tables.bucket.output', 'Name of the new column')} placeholder={op.column ? `${op.column} (group)` : ''} />}
            </OpField>
            <OpField ctx={ctx} name="mode" label={t('automation_tables.bucket.mode', 'How to sort')} help={h.mode}>
                <Radios
                    ariaLabel={t('automation_tables.bucket.mode', 'How to sort')} value={op.mode} onChange={mode => set({ mode })}
                    options={[
                        { value: 'bands', label: t('automation_tables.bucket.mode_bands', 'Bands I set') },
                        { value: 'quantiles', label: t('automation_tables.bucket.mode_quantiles', 'Equal parts') },
                        { value: 'values', label: t('automation_tables.bucket.mode_values', 'A list of values') },
                    ]}
                />
            </OpField>
            {op.mode === 'bands' && <BandRows op={op} set={set} ctx={ctx} />}
            {op.mode === 'quantiles' && (
                <>
                    <OpField ctx={ctx} name="quantiles" label={t('automation_tables.bucket.quantiles', 'Number of parts')} help={h.quantiles}>
                        {id => <NumberInput id={id} value={op.quantiles} min={2} max={20} onChange={n => set({ quantiles: n ?? 4 })} ariaLabel={t('automation_tables.bucket.quantiles', 'Number of parts')} />}
                    </OpField>
                    <OpField ctx={ctx} name="labels" label={t('automation_tables.bucket.labels', 'Names of the parts')} help={h.labels}>
                        {id => <ListInput id={id} value={op.labels || []} onChange={labels => set({ labels: labels.length ? labels : null })} ariaLabel={t('automation_tables.bucket.labels', 'Names of the parts')} placeholder={t('automation_tables.bucket.labels_placeholder', 'Low, Middle, High')} />}
                    </OpField>
                </>
            )}
            {op.mode === 'values' && <ValueRows op={op} set={set} ctx={ctx} />}
            {op.mode !== 'quantiles' && (
                <OpField ctx={ctx} name="otherLabel" label={t('automation_tables.bucket.other', 'Label for everything else')} help={h.otherLabel}>
                    {id => <TextInput id={id} value={op.otherLabel ?? ''} onChange={otherLabel => set({ otherLabel: otherLabel || null })} ariaLabel={t('automation_tables.bucket.other', 'Label for everything else')} />}
                </OpField>
            )}
        </div>
    );
}
