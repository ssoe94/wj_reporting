import { useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '../i18n';

type EmbeddedNextPageProps = {
  page: 'production' | 'mes-monitoring';
};

const NEXT_APP_BASE_PATH = '/next';
const MIN_FRAME_HEIGHT = 720;

const embedCopy = {
  ko: {
    production: '생산현황 대시보드',
    mesMonitoring: '사출 모니터링',
    loading: '화면을 불러오는 중입니다.',
  },
  zh: {
    production: '生产现状仪表板',
    mesMonitoring: '注塑监控',
    loading: '正在加载页面。',
  },
} as const;

function createFrameId(page: EmbeddedNextPageProps['page']) {
  return `wj-next-${page}-${Math.random().toString(36).slice(2)}`;
}

export default function EmbeddedNextPage({ page }: EmbeddedNextPageProps) {
  const { lang } = useLang();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const frameId = useMemo(() => createFrameId(page), [page]);
  const [frameHeight, setFrameHeight] = useState(MIN_FRAME_HEIGHT);
  const copy = embedCopy[lang];
  const title = page === 'production' ? copy.production : copy.mesMonitoring;
  const targetPath = page === 'production' ? '/production' : '/mes/monitoring';
  const src = `${NEXT_APP_BASE_PATH}${targetPath}?embed=1&frameId=${encodeURIComponent(frameId)}`;

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (!event.data || event.data.type !== 'wj-next-embed-height') return;
      if (event.data.frameId !== frameId) return;

      const nextHeight = Number(event.data.height);
      if (!Number.isFinite(nextHeight)) return;
      setFrameHeight(Math.max(MIN_FRAME_HEIGHT, Math.ceil(nextHeight)));
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [frameId]);

  return (
    <section className="embedded-next-page" aria-label={title}>
      <iframe
        ref={iframeRef}
        className="embedded-next-page__frame"
        src={src}
        title={title}
        style={{ height: frameHeight }}
      />
      <p className="embedded-next-page__loading" aria-hidden="true">
        {copy.loading}
      </p>
    </section>
  );
}
