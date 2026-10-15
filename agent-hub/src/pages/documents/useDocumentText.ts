import useTranslation from '../../hooks/useTranslation';
export default function useDocumentText() {
    const { locale } = useTranslation();
    return (en: string, nl?: string) => String(locale || '').startsWith('nl') ? (nl || en) : en;
}
