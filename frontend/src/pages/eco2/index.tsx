import Eco2Manager from '../../components/Eco2Manager';
import { useLang } from '../../i18n';

export default function Eco2Page(){
  const { t } = useLang();
  return (
    <div className="p-4">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t('eco2Title')}</h1>
        <p className="text-gray-600 mt-2">{t('eco2_desc')}</p>
      </div>
      <Eco2Manager />
    </div>
  );
}