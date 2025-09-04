import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import QualityReport from './report';
import QualityStats from './stats';

export default function QualityPage() {
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
      {/* Report Section */}
      <section id="report" className="space-y-6">
        <QualityReport />
      </section>

      {/* Stats Section */}
      <section id="stats" className="space-y-6">
        <QualityStats />
      </section>
    </div>
  );
}



