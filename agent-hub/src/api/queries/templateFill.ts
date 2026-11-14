// Filling a document template from chat values: POST …/fill-and-store, then the
// stored file itself (fetched with the session so the browser can save it).
// Each call hands its Response back as it came: the caller reads `ok`.

import { useMutation } from '@tanstack/react-query';
import { templatesApi } from '../templatesApi';

export function useFillTemplateMutation() {
    return useMutation<Response, Error, { templateId: string; values: unknown }>({
        mutationFn: ({ templateId, values }) => templatesApi.fillAndStore(templateId, values),
    });
}

export function useTemplateFileMutation() {
    return useMutation<Response, Error, string>({
        mutationFn: (url) => templatesApi.file(url),
    });
}
