import MarkdownRenderer from '@/components/renderers/MarkdownRenderer';
import type { TranslateFn } from '@/hooks/useTranslation';

export interface EffectPreview { id: string; title: string; effect: string; preview: string | null }

/** Render a recorded input as labelled fields, or as Markdown when it is already text. */
function Preview({ value }: { value: string }) {
    let fields: unknown;
    try { fields = JSON.parse(value); } catch { /* Plain text or a shortened preview. */ }
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
        return <dl>{Object.entries(fields).map(([name, v]) => <div key={name}>
            <dt className="font-medium">{name}</dt>
            <dd className="whitespace-pre-wrap break-words">{typeof v === 'string' ? v : JSON.stringify(v, null, 2)}</dd>
        </div>)}</dl>;
    }
    return <MarkdownRenderer content={value} />;
}

export default function CoworkEffectPreview({ effects, t }: { effects: EffectPreview[]; t: TranslateFn }) {
    if (!effects.length) return null;
    return <ul className="flex flex-col gap-2">{effects.map((step) => <li key={step.id}>
        <strong>{step.effect === 'writes' ? t('cowork_task.preview.write', 'Would change') : t('cowork_task.preview.send', 'Would send')} · {step.title}</strong>
        {step.preview && <Preview value={step.preview} />}
    </li>)}</ul>;
}
