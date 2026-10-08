import { Children, isValidElement, useId, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

type PanelProps = { children?: ReactNode; open?: boolean; 'data-panel'?: string };

/** Keep panel forms mounted so switching auxiliary views never discards inputs. */
export default function InspectionAuxiliaryTabs({ children, actions, label }: {
  children: ReactNode; actions?: ReactNode; label: string;
}) {
  const prefix = useId();
  const panels = Children.toArray(children).filter((child): child is ReactElement<PanelProps> => isValidElement<PanelProps>(child) && child.type === 'details').map((panel, index) => {
    const contents = Children.toArray(panel.props.children);
    const summary = contents.find((child) => isValidElement(child) && child.type === 'summary') as ReactElement<{ children?: ReactNode }> | undefined;
    return { key: panel.props['data-panel'] || String(index), title: summary?.props.children, body: contents.filter((child) => child !== summary), initiallyOpen: panel.props.open };
  });
  const [active, setActive] = useState<string | null>(() => panels.find((panel) => panel.initiallyOpen)?.key || null);
  return <section className="inspection-auxiliary-tabs" aria-label={label}>
    <div className="inspection-auxiliary-tabbar">
      <div className="inspection-auxiliary-buttons">{panels.map((panel) => <button key={panel.key} id={`${prefix}-${panel.key}-button`} type="button" className="inspection-button inspection-auxiliary-tab" aria-expanded={active === panel.key} aria-controls={`${prefix}-${panel.key}-content`} onClick={() => setActive((current) => current === panel.key ? null : panel.key)}>{panel.title}<ChevronDown size={14} aria-hidden="true" /></button>)}</div>
      {actions && <div className="inspection-auxiliary-tab-actions">{actions}</div>}
    </div>
    {panels.map((panel) => <div key={panel.key} id={`${prefix}-${panel.key}-content`} className="inspection-auxiliary-content" role="region" aria-labelledby={`${prefix}-${panel.key}-button`} hidden={active !== panel.key}>{panel.body}</div>)}
  </section>;
}
