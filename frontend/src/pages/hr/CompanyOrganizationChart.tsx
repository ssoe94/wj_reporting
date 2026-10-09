import { COMPANY_ORGANIZATION } from '../../domains/hr/company-structure';
import { useLang } from '../../i18n';
import { CompanyChartViewport } from './CompanyClassificationChart';
import './company-structure.css';

const WIDTH = 2200;
const HEIGHT = 1220;
type NodePosition = { x: number; y: number; size: number; style: string };
const POSITIONS: Record<string, NodePosition> = {
  chairman: { x: 1066, y: 258, size: 210, style: 'is-chairman' },
  qa: { x: 1668, y: 408, size: 176, style: 'is-qa' },
  business: { x: 660, y: 512, size: 192, style: 'is-deputy' },
  technical: { x: 1457, y: 512, size: 192, style: 'is-deputy' },
  esh: { x: 269, y: 644, size: 158, style: 'is-support' },
  office: { x: 395, y: 778, size: 176, style: 'is-manager' },
  'sales-operations': { x: 927, y: 778, size: 176, style: 'is-manager' },
  development: { x: 1258, y: 778, size: 176, style: 'is-manager' },
  production: { x: 1653, y: 778, size: 176, style: 'is-manager' },
  hr: { x: 288, y: 1035, size: 176, style: '' },
  finance: { x: 501, y: 1035, size: 176, style: '' },
  'production-management': { x: 818, y: 1035, size: 176, style: '' },
  purchasing: { x: 1032, y: 1035, size: 176, style: '' },
  injection: { x: 1338, y: 1035, size: 176, style: '' },
  machining: { x: 1553, y: 1035, size: 176, style: '' },
  mold: { x: 1766, y: 1035, size: 176, style: '' },
  maintenance: { x: 1979, y: 1035, size: 176, style: '' },
};

function connector(fromId: string, toId: string) {
  const from = POSITIONS[fromId]; const to = POSITIONS[toId];
  if (!from || !to) return '';
  const bottom = from.y + from.size / 2;
  if (fromId === 'chairman' || fromId === 'business' || fromId === 'technical') {
    const edge = to.x < from.x ? to.x + to.size / 2 : to.x - to.size / 2;
    return `M ${from.x} ${bottom} V ${to.y} H ${edge}`;
  }
  const top = to.y - to.size / 2;
  const rail = bottom + (top - bottom) * 0.45;
  return `M ${from.x} ${bottom} V ${rail} H ${to.x} V ${top}`;
}

export default function CompanyOrganizationChart({ organization = COMPANY_ORGANIZATION }: { organization?: typeof COMPANY_ORGANIZATION }) {
  const { lang } = useLang(); const ko = lang === 'ko';
  const nodes = organization.nodes;
  function list(parentId: string | null) {
    return <ul>{nodes.filter((node) => node.parent_id === parentId).map((node) => <li key={node.id}><strong>{node.label.replaceAll('\n', ' ')}</strong>{nodes.some((child) => child.parent_id === node.id) && list(node.id)}</li>)}</ul>;
  }
  return <section className="hr-panel company-organization">
    <CompanyChartViewport title={ko ? '회사 전체 조직도 · 보고체계' : '公司整体组织图 · 汇报体系'}
      description={ko ? '회사 조직도의 직책과 보고 관계입니다.' : '按公司组织图展示职务与汇报关系。'}
      width={WIDTH} height={HEIGHT} canvasClass="company-organization-canvas" label={ko ? '회사 전체 보고체계 조직도' : '公司整体汇报体系组织图'}>
      <svg className="company-organization-lines" width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true">{organization.edges.map((edge) => <path key={`${edge.from}-${edge.to}`} d={connector(edge.from, edge.to)} />)}</svg>
      {nodes.map((node) => {
        const position = POSITIONS[node.id]; if (!position) return null;
        return <div key={node.id} data-organization-node={node.id} className={`company-organization-node ${position.style}`} style={{ left: position.x - position.size / 2, top: position.y - position.size / 2, width: position.size, height: position.size }}><strong>{node.label}</strong></div>;
      })}
    </CompanyChartViewport>
    <details className="company-organization-accessible"><summary>{ko ? '보고체계를 목록으로 보기' : '以列表查看汇报体系'}</summary>{list(null)}</details>
  </section>;
}
