import { useId } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { INPUT, HINT, LABEL, QUIET_BTN } from '@/components/mcpLibrary/ui';
import { AZURE_IMAGE_MODEL_SUGGESTIONS, MAX_DEPLOYMENT_NAME, MAX_IMAGE_DEPLOYMENTS, MAX_IMAGE_PRICE, emptyImageRow } from './azureImageRows';
import type { AzureImageRow } from './azureImageRows';

interface AzureImageDeploymentsProps {
    rows: AzureImageRow[];
    onChange: (rows: AzureImageRow[]) => void;
}

/**
 * The image deployments of the Azure provider: deployment name, the model
 * behind it (a suggestion list, any text allowed) and the price of one image.
 * Saved with the form's own Save.
 */
export default function AzureImageDeployments({ rows, onChange }: AzureImageDeploymentsProps) {
    const { t } = useTranslation();
    const listId = useId();
    const update = (key: string, patch: Partial<AzureImageRow>) => onChange(rows.map(r => (r.key === key ? { ...r, ...patch } : r)));
    const remove = (key: string) => onChange(rows.filter(r => r.key !== key));
    const deploymentLabel = t('azure_image_deployments.deployment', 'Deployment name');
    const modelLabel = t('azure_image_deployments.model', 'Model');
    const priceLabel = t('azure_image_deployments.price', 'Price per image (€)');

    return (
        <div className="space-y-2 pt-1">
            <p className="text-[13px] font-medium text-[var(--text-primary)]">{t('azure_image_deployments.title', 'Image deployments')}</p>
            <datalist id={listId}>
                {AZURE_IMAGE_MODEL_SUGGESTIONS.map(m => <option key={m} value={m} />)}
            </datalist>
            {rows.length > 0 && (
                <div className="hidden sm:grid grid-cols-[1fr_1fr_7rem_2rem] gap-2">
                    <span className={LABEL}>{deploymentLabel}</span>
                    <span className={LABEL}>{modelLabel}</span>
                    <span className={LABEL}>{priceLabel}</span>
                </div>
            )}
            {rows.map((row, i) => (
                <div key={row.key} className="grid grid-cols-2 sm:grid-cols-[1fr_1fr_7rem_2rem] gap-2 items-center">
                    <input
                        type="text"
                        value={row.deployment}
                        maxLength={MAX_DEPLOYMENT_NAME}
                        onChange={e => update(row.key, { deployment: e.target.value })}
                        placeholder={t('azure_image_deployments.deployment_placeholder', 'e.g. images-prod')}
                        aria-label={`${deploymentLabel} ${i + 1}`}
                        className={`${INPUT} col-span-2 sm:col-span-1`}
                    />
                    <input
                        type="text"
                        list={listId}
                        value={row.model}
                        maxLength={MAX_DEPLOYMENT_NAME}
                        onChange={e => update(row.key, { model: e.target.value })}
                        placeholder={t('azure_image_deployments.model_placeholder', 'e.g. gpt-image-1.5')}
                        aria-label={`${modelLabel} ${i + 1}`}
                        className={`${INPUT} col-span-2 sm:col-span-1`}
                    />
                    <input
                        type="number"
                        min="0"
                        max={MAX_IMAGE_PRICE}
                        step="0.001"
                        inputMode="decimal"
                        value={row.price}
                        onChange={e => update(row.key, { price: e.target.value })}
                        placeholder={t('azure_image_deployments.price_placeholder', 'Not set')}
                        aria-label={`${priceLabel} ${i + 1}`}
                        className={INPUT}
                    />
                    <button
                        type="button"
                        onClick={() => remove(row.key)}
                        aria-label={t('azure_image_deployments.remove', 'Remove deployment {n}', { n: i + 1 })}
                        title={t('azure_image_deployments.remove_title', 'Remove')}
                        className={`${QUIET_BTN} justify-self-end`}
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                    </button>
                </div>
            ))}
            {rows.length < MAX_IMAGE_DEPLOYMENTS && (
                <button type="button" onClick={() => onChange([...rows, emptyImageRow()])} className={QUIET_BTN}>
                    <Plus className="w-3.5 h-3.5" />
                    {t('azure_image_deployments.add', 'Add image deployment')}
                </button>
            )}
            <p className={HINT}>
                {t('azure_image_deployments.hint', 'Uses the endpoint and key above. Supported models: gpt-image and MAI-Image (FLUX is not). The price per image is what Usage shows for each image; leave it empty to record no cost.')}
            </p>
        </div>
    );
}
