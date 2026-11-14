import { useLocation } from 'react-router-dom';
import { workStep } from '../../domains/hr/flow';
import DailyWorkPage from './DailyWorkPage';
import LaborForecastPage from './LaborForecastPage';
import LaborStandardsPage from './LaborStandardsPage';

export default function WorkPage() {
  const { search } = useLocation();
  const step = workStep(search);
  if (step === 'forecast') return <LaborForecastPage />;
  if (step === 'standards') return <LaborStandardsPage />;
  return <DailyWorkPage />;
}
