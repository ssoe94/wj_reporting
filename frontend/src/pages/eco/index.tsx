import EcoManager from '../../components/EcoManager';
import { useLang } from '../../i18n';

export default function EcoPage(){
  const { t } = useLang();
  return (
    <div className="p-4">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[var(--wj-text)]">{t('ecoTitle')}</h1>
        <p className="text-[var(--wj-muted)] mt-2">{t('eco_desc')}</p>
      </div>
      <EcoManager />
    </div>
  );
} 