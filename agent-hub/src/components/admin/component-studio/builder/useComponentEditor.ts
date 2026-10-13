// The Component Studio builder's behaviour: the component list, which one is
// open (kept in `?component=`), and every action on it: load, new, save,
// delete (one, the open one, a whole category), test run and "save sample".
// ComponentBuilder renders what this returns.

import { useEffect, useState } from 'react';
import {
    deleteComponent,
    fetchComponent,
    fetchComponents as requestComponents,
    runComponentTest,
    saveComponent,
    saveComponentSample,
} from '../../../../api/componentStudio';
import { useTranslation } from '../../../../hooks/useTranslation';
import { toast } from '../../../shared/Toast';
import useConfirm from '../../../shared/useConfirm';
import {
    defaultTestInput,
    flattenSchema,
    generateOutputSchema,
    serializeDependencies,
    serializeInputs,
    serializeOutputs,
} from './componentForm';
import type { ComponentSummary } from './componentForm';
import { useComponentDraft } from './useComponentDraft';

const errorMessage = (err: unknown) => (err as Error).message;

// Update URL when component changes
function updateUrl(componentId: string | null) {
    const url = new URL(window.location.href);
    if (componentId) {
        url.searchParams.set('component', componentId);
    } else {
        url.searchParams.delete('component');
    }
    window.history.pushState({}, '', url);
}

/** The list of components and its loading flag; fetched once on mount. */
function useComponentList() {
    const [components, setComponents] = useState<ComponentSummary[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchComponents = async () => {
        setLoading(true);
        try {
            const res = await requestComponents();
            const data = await res.json();
            setComponents(data);
        } catch (err) {
            console.error('Failed to fetch components:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchComponents();
    }, []);

    return { components, loading, fetchComponents };
}

export function useComponentEditor() {
    const { t } = useTranslation();
    const { components, loading, fetchComponents } = useComponentList();
    const [selectedComponent, setSelectedComponent] = useState<string | null>(null);
    const [isCreating, setIsCreating] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [activeTab, setActiveTab] = useState('config');
    const draft = useComponentDraft();
    const { formData, setIsDirty, setTestInput, setTestOutput } = draft;
    const { confirm, confirmDialog } = useConfirm();

    const handleSelectComponent = async (comp: ComponentSummary) => {
        try {
            const res = await fetchComponent(comp.id);
            const data = await res.json();
            setSelectedComponent(comp.id);
            const parsedInputs = draft.loadDefinition(comp.id, data);
            setIsCreating(false);
            setActiveTab('config');
            setIsDirty(false);
            updateUrl(comp.id);
            // Generate test input from inputs
            setTestInput(defaultTestInput(parsedInputs));
            setTestOutput(null);
        } catch (err) {
            console.error('Failed to load component:', err);
        }
    };

    // Load component from URL on mount
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const componentId = params.get('component');
        if (componentId && components.length > 0 && !selectedComponent) {
            const comp = components.find(c => c.id === componentId);
            if (comp) handleSelectComponent(comp);
        }
    }, [components]);

    const handleNewComponent = () => {
        setSelectedComponent(null);
        setIsCreating(true);
        draft.loadStarter();
        setActiveTab('config');
        setTestOutput(null);
        updateUrl(null);
    };

    const handleSave = async () => {
        if (isCreating && !formData.id.match(/^[a-z0-9-]+$/)) {
            toast.error(t('component_studio.builder.err_id_format', 'Component ID must be lowercase letters, numbers, and hyphens only.'));
            return;
        }
        if (!formData.name) {
            toast.error(t('component_studio.builder.err_name_required', 'Component name is required.'));
            return;
        }

        const inputs = serializeInputs(draft.inputsList);
        const outputs = serializeOutputs(draft.outputsList);
        const dependencies = serializeDependencies(draft.dependenciesList);

        setIsSaving(true);
        try {
            const res = await saveComponent(isCreating, selectedComponent, { ...formData, inputs, outputs, dependencies });
            const result = await res.json();
            if (result.error) {
                toast.error(result.error);
            } else {
                fetchComponents();
                setIsDirty(false);
                if (isCreating) {
                    setSelectedComponent(formData.id);
                    setIsCreating(false);
                    updateUrl(formData.id);
                }
            }
        } catch (err) {
            toast.error(t('component_studio.builder.err_save_failed', 'Failed to save component: {error}', { error: errorMessage(err) }));
        } finally {
            setIsSaving(false);
        }
    };

    const confirmDelete = (title: string) => confirm({ title, description: t('component_studio.builder.confirm_cannot_undo', 'This cannot be undone.'), confirmLabel: t('component_studio.builder.delete', 'Delete'), destructive: true });

    const handleDelete = async () => {
        if (!selectedComponent) return;
        if (!(await confirmDelete(t('component_studio.builder.confirm_delete_title', 'Delete "{name}"?', { name: formData.name })))) return;

        try {
            await deleteComponent(selectedComponent);
            fetchComponents();
            handleNewComponent();
        } catch (err) {
            toast.error(t('component_studio.builder.err_delete_failed', 'Failed to delete component: {error}', { error: errorMessage(err) }));
        }
    };

    const handleDeleteCategory = async (category: string, componentsInCategory: ComponentSummary[]) => {
        const count = componentsInCategory.length;
        if (!(await confirmDelete(t('component_studio.builder.confirm_delete_category_title', 'Delete all {count} components in "{category}"?', { count, category })))) return;

        try {
            for (const comp of componentsInCategory) {
                await deleteComponent(comp.id);
            }
            fetchComponents();
            if (selectedComponent && componentsInCategory.some(c => c.id === selectedComponent)) {
                handleNewComponent();
            }
        } catch (err) {
            toast.error(t('component_studio.builder.err_delete_category_failed', 'Failed to delete category: {error}', { error: errorMessage(err) }));
        }
    };

    const handleDeleteSingleComponent = async (e: { stopPropagation: () => void }, compId: string, compName: string) => {
        e.stopPropagation();
        if (!(await confirmDelete(t('component_studio.builder.confirm_delete_title', 'Delete "{name}"?', { name: compName })))) return;

        try {
            await deleteComponent(compId);
            fetchComponents();
            if (selectedComponent === compId) {
                handleNewComponent();
            }
        } catch (err) {
            toast.error(t('component_studio.builder.err_delete_failed', 'Failed to delete component: {error}', { error: errorMessage(err) }));
        }
    };

    const handleTest = async () => {
        draft.setIsTesting(true);
        setTestOutput(null);
        try {
            const testInputObj = JSON.parse(draft.testInput);
            const res = await runComponentTest(selectedComponent || formData.id, testInputObj);
            const result = await res.json();
            setTestOutput(result);
        } catch (err) {
            setTestOutput({ error: errorMessage(err) });
        } finally {
            draft.setIsTesting(false);
        }
    };

    // Save test output as sampleOutput AND generate outputs schema
    const handleSaveSampleOutput = async () => {
        const { testOutput } = draft;
        if (!testOutput || !selectedComponent) return;

        // Generate simplified outputs schema from test result
        const flatOutputs = flattenSchema(generateOutputSchema(testOutput));

        try {
            const res = await saveComponentSample(selectedComponent, testOutput, flatOutputs);

            if (res.ok) {
                // Update local state to reflect new outputs
                draft.setFormData(prev => ({ ...prev, outputs: flatOutputs }));
                toast.success(t('component_studio.builder.sample_saved', 'Saved! Updated both sampleOutput and outputs schema.'));
            } else {
                const err = await res.json();
                toast.error(t('component_studio.builder.err_save_sample_failed', 'Failed to save: {error}', { error: err.error }));
            }
        } catch (err) {
            toast.error(t('component_studio.builder.err_generic', 'Error: {error}', { error: errorMessage(err) }));
        }
    };

    return {
        components,
        loading,
        fetchComponents,
        selectedComponent,
        isCreating,
        isSaving,
        activeTab,
        setActiveTab,
        draft,
        confirmDialog,
        handleSelectComponent,
        handleNewComponent,
        handleSave,
        handleDelete,
        handleDeleteCategory,
        handleDeleteSingleComponent,
        handleTest,
        handleSaveSampleOutput,
    };
}

export type ComponentEditor = ReturnType<typeof useComponentEditor>;
