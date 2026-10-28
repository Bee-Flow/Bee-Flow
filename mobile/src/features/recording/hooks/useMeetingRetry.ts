/**
 * Re-transcribe from the saved audio. A refusal is a dialog rather than a toast:
 * each code means something different to the person holding the phone
 * (model/reprocess.ts), and they need to be able to read it.
 */

import { Alert } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useToast } from '@/shared/ui';

import { useReprocessTranscription } from './mutations';
import { reprocessErrorCode, reprocessFailureMessage } from '../model/reprocess';

export function useMeetingRetry(id: string) {
    const t = useTranslation();
    const { toast } = useToast();
    return useReprocessTranscription(id, {
        onSuccess: () => toast(t('mobile.recording.retranscribing', 'Transcribing again'), 'success'),
        onError: (err) => {
            const message = reprocessFailureMessage(reprocessErrorCode(err), describeError(err).message);
            Alert.alert(t('mobile.recording.retranscribe_refused', 'Cannot re-transcribe'), message);
        },
    });
}
