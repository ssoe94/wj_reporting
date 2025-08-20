import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import AssemblySummaryPage from './Summary';
import AssemblyRecordsPage from './Records';
import AssemblyNewPage from './New';

export default function AssemblyPage() {
  const location = useLocation();
  
  useEffect(() => {
    if (location.hash) {
      const id = location.hash.replace('#', '');
      const el = document.getElementById(id);
      if (el) {
        setTimeout(() => {
          el.scrollIntoView({ behavior: 'smooth' });
        }, 50);
      } else if (id === 'top') {
        setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 50);
      }
    }
  }, [location.hash]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 flex flex-col gap-10">
      {/* Summary Section */}
      <section id="top" className="space-y-6">
        <AssemblySummaryPage />
      </section>

      {/* Records Section */}
      <section id="records" className="space-y-6">
        <AssemblyRecordsPage />
      </section>

      {/* New Record Section */}
      <section id="new" className="space-y-6">
        <AssemblyNewPage />
      </section>
    </div>
  );
} 