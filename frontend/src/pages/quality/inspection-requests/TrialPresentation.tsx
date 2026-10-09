import { inspectionTime } from './copy';
import { integrationTrialCopy, parseIntegrationTrials } from './integrationTrial';
import './IntegrationTrial.css';

export function IntegrationTrialBadge({ lang }: { lang: 'ko' | 'zh' }) {
  return <span className="inspection-trial-badge" data-testid="integration-trial-badge">{integrationTrialCopy[lang].badge}</span>;
}

export function IntegrationTrialSection({ rows, lang, available = true, onSelect }: {
  rows: unknown; lang: 'ko' | 'zh'; available?: boolean; onSelect?: (id: number) => void;
}) {
  const copy = integrationTrialCopy[lang];
  const trials = parseIntegrationTrials(rows);
  return <section className="inspection-trials" data-testid="integration-trial-section" aria-label={copy.title}>
    <header><h3>{copy.title} · {available ? trials.length : '—'}</h3><IntegrationTrialBadge lang={lang} /></header>
    <p>{copy.excluded}</p>
    {!available ? <p>{copy.unavailable}</p> : !trials.length ? <p>{copy.empty}</p> : <ul>{trials.map((row) => {
      const id = Number(row.request_id);
      const label = row.qc_code || `WJ #${row.request_id}`;
      const phase = copy.phases[row.phase as keyof typeof copy.phases] || copy.unknown;
      return <li key={row.request_id}>
        <strong>{onSelect && Number.isSafeInteger(id) ? <button type="button" onClick={() => onSelect(id)}>{label}</button> : label}</strong>
        <IntegrationTrialBadge lang={lang} /><span>{phase}</span>
        {row.phase === 'unbound' && <small>{lang === 'ko' ? '준비 코드 · MES 생성 전' : '准备代码 · MES 尚未创建'}</small>}
        <span>{copy.verdict}: {row.trial_verdict === 'pass' ? copy.pass : row.trial_verdict === 'fail' ? copy.fail : copy.unknown}</span>
        <small>{copy.observed}: {row.observed_at ? inspectionTime(row.observed_at, lang) : copy.unknown}</small>
        <small>{row.test_label}</small>
      </li>;
    })}</ul>}
  </section>;
}
