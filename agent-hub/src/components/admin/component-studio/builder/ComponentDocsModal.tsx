// The "Component Development Guide" modal of the builder.

import { useTranslation } from '../../../../hooks/useTranslation';

export default function ComponentDocsModal({ onClose }: { onClose: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="modal-overlay" onClick={onClose}>
            <div
                className="modal-content max-w-4xl max-h-[90vh] overflow-hidden flex flex-col"
                style={{ width: '900px' }}
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center justify-between pb-4 border-b" style={{ borderColor: 'var(--border-default)' }}>
                    <h2 className="modal-title">{t('component_studio.builder.guide_title', 'Component Development Guide')}</h2>
                    <button onClick={onClose} className="btn-icon">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>
                <div className="flex-1 overflow-auto pt-4 space-y-6">
                    <section>
                        <h3 className="text-base font-semibold text-primary mb-2">{t('component_studio.builder.guide_structure', '📦 Component Structure')}</h3>
                        <p className="text-sm text-secondary mb-2">{t('component_studio.builder.guide_stored_in', 'Each component is stored in')} <code className="badge badge-primary font-mono">/components/component-id/</code> {t('component_studio.builder.guide_and_contains', 'and contains:')}</p>
                        <ul className="text-sm text-secondary list-disc pl-5 space-y-1">
                            <li><strong>component.json</strong> {t('component_studio.builder.guide_json_desc', '— Name, inputs, outputs, category')}</li>
                            <li><strong>package.json</strong> {t('component_studio.builder.guide_package_desc', '— NPM dependencies (isolated per component)')}</li>
                            <li><strong>index.js</strong> {t('component_studio.builder.guide_index_desc', '— Execution logic')}</li>
                        </ul>
                    </section>

                    <section>
                        <h3 className="text-base font-semibold text-primary mb-2">{t('component_studio.builder.guide_flow', '⚡ Execution Flow')}</h3>
                        <div className="text-sm text-secondary space-y-1">
                            <p>{t('component_studio.builder.guide_step1_a', '1. Component receives')} <strong>{t('component_studio.builder.guide_step1_b', 'JSON via stdin')}</strong> {t('component_studio.builder.guide_step1_c', '(configured inputs)')}</p>
                            <p>{t('component_studio.builder.guide_step2', '2. Performs logic (API calls, data processing, etc.)')}</p>
                            <p>{t('component_studio.builder.guide_step3_a', '3. Outputs')} <strong>{t('component_studio.builder.guide_step3_b', 'JSON via stdout')}</strong> {t('component_studio.builder.guide_step3_c', '(available to downstream nodes)')}</p>
                        </div>
                    </section>

                    <section>
                        <h3 className="text-base font-semibold text-primary mb-2">{t('component_studio.builder.guide_template', '📝 Code Template')}</h3>
                        <pre className="text-xs p-4 rounded-lg overflow-auto font-mono" style={{ background: '#1a1a2e', color: '#e0e0e0' }}>
                            {`let inputData = '';
process.stdin.on('data', chunk => inputData += chunk);

process.stdin.on('end', async () => {
    try {
        const inputs = JSON.parse(inputData);
        
        // Your logic here
        const result = { output: inputs.input };
        
        console.log(JSON.stringify(result));
    } catch (e) {
        process.stderr.write(e.message);
        process.exit(1);
    }
});`}
                        </pre>
                    </section>

                    <section>
                        <h3 className="text-base font-semibold text-primary mb-2">{t('component_studio.builder.guide_tips', '💡 Tips')}</h3>
                        <ul className="text-sm text-secondary list-disc pl-5 space-y-1">
                            <li><strong>{t('component_studio.builder.tip_json_a', 'Output must be valid JSON')}</strong> {t('component_studio.builder.tip_json_b', '— use')} <code className="font-mono text-xs">JSON.stringify()</code></li>
                            <li><strong>{t('component_studio.builder.tip_errors_a', 'Handle errors')}</strong> {t('component_studio.builder.tip_errors_b', '— write to stderr, exit with code 1')}</li>
                            <li><strong>{t('component_studio.builder.tip_async_a', 'Async is supported')}</strong> {t('component_studio.builder.tip_async_b', '— just output before process ends')}</li>
                            <li><strong>{t('component_studio.builder.tip_categories_a', 'Use categories')}</strong> {t('component_studio.builder.tip_categories_b', '— group with / (e.g., "Nextcloud/Files")')}</li>
                        </ul>
                    </section>
                </div>
            </div>
        </div>
    );
}
