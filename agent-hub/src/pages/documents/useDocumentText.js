import useTranslation from '../../hooks/useTranslation';
export default function useDocumentText() {
    const { locale } = useTranslation();
    return (en, nl) => String(locale || '').startsWith('nl') ? (nl || en) : en;
}
