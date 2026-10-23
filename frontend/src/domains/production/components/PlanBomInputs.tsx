import { materialRequirement } from "../plan-workflow-form";

export type PlanBomSourceInput = {
  source_row_id: string;
  seq: string | number;
  material_id: string;
  material_code: string;
  material_name: string;
  material_version: string;
  unit_id: string;
  unit_name: string;
  numerator: string;
  denominator: string;
  category_code: string;
  category_name: string;
  replaceable: boolean;
};

export type PlanBomSource = {
  id: string;
  version: string;
  material_id: string;
  part_no: string;
  hash: string;
  inputs: readonly PlanBomSourceInput[];
  setup: {
    bom_version: string;
    process_code: string;
    process_num: string;
    route_code: string;
    output_unit_id: string;
    output_unit_name: string;
    output_version: string;
  };
};

export type PlanBomCatalogMaterial = {
  material_code: string;
  material_name: string;
  unit_id: string;
  unit_name: string;
  selectable: boolean;
};
export type PlanBomInputSelection = { source_row_id: string; material_code: string; numerator?: string };
export type PlanBomInputsProps = {
  source: PlanBomSource | null;
  catalog: readonly PlanBomCatalogMaterial[];
  quantity: string;
  value: readonly PlanBomInputSelection[];
  onChange: (value: PlanBomInputSelection[]) => void;
  disabled?: boolean;
  hidePrimary?: boolean;
  ko: boolean;
};

export function initialPlanBomInputs(source: PlanBomSource): PlanBomInputSelection[] {
  return source.inputs.map(({ source_row_id, material_code }) => ({ source_row_id, material_code }));
}

export function canEditPlanBomRatio(row: PlanBomSourceInput): boolean {
  return row.replaceable === true && row.category_code === "CAT-011" && /^1(?:\.0+)?$/.test(row.denominator);
}

export function selectedPlanBomNumerator(row: PlanBomSourceInput, value: readonly PlanBomInputSelection[]): string {
  return value.find(input => input.source_row_id === row.source_row_id)?.numerator ?? row.numerator;
}

function validNumerator(value: string): boolean {
  return /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,10})?$/.test(value)
    && materialRequirement("1", value, "1") !== null;
}

function replacementOptions(row: PlanBomSourceInput, catalog: readonly PlanBomCatalogMaterial[]) {
  const options = new Map<string, PlanBomCatalogMaterial>([[row.material_code, {
    material_code: row.material_code, material_name: row.material_name,
    unit_id: row.unit_id, unit_name: row.unit_name, selectable: true,
  }]]);
  if (row.replaceable === true) catalog.forEach(material => {
    // The fixed source ratio only applies to the same unit. The server decides which rows may change.
    if (material.selectable === true && material.unit_id === row.unit_id
      && material.material_code && !options.has(material.material_code)) options.set(material.material_code, material);
  });
  return [...options.values()];
}

function hasExactSourceRows(source: PlanBomSource, value: readonly PlanBomInputSelection[]): boolean {
  const ids = source.inputs.map(row => row.source_row_id);
  return ids.length > 0 && ids.every(id => typeof id === "string" && id.length > 0)
    && new Set(ids).size === ids.length && value.length === ids.length
    && new Set(value.map(row => row.source_row_id)).size === ids.length
    && value.every(row => ids.includes(row.source_row_id));
}

/** Gate approval with the controlled values, never with a browser's fallback option. */
export function isPlanBomSelectionValid(source: PlanBomSource | null, catalog: readonly PlanBomCatalogMaterial[],
  value: readonly PlanBomInputSelection[]): boolean {
  if (!source || !hasExactSourceRows(source, value)) return false;
  return source.inputs.every(row => {
    const selected = value.find(input => input.source_row_id === row.source_row_id)!;
    return replacementOptions(row, catalog).some(option => option.material_code === selected.material_code)
      && (selected.numerator === undefined || (canEditPlanBomRatio(row)
        && validNumerator(selected.numerator)));
  });
}

function materialLabel(material: { material_code: string; material_name: string }): string {
  return !material.material_name || material.material_code === material.material_name
    ? material.material_code : `${material.material_code} · ${material.material_name}`;
}

function materialSelect({ source, catalog, value, onChange, disabled = false, ko }: PlanBomInputsProps,
  row: PlanBomSourceInput, index: number) {
  const exactRows = source !== null && hasExactSourceRows(source, value);
  const selectedCode = value.find(input => input.source_row_id === row.source_row_id)?.material_code ?? "";
  const options = replacementOptions(row, catalog);
  const selectionValid = exactRows && options.some(option => option.material_code === selectedCode);
  return <select aria-label={`${ko ? "사용 원료" : "使用原料"} ${index + 1}. ${row.material_code}`}
    aria-invalid={!selectionValid} value={selectedCode} disabled={disabled || !exactRows}
    onChange={event => {
      const code = event.target.value;
      if (disabled || !exactRows || !options.some(option => option.material_code === code)) return;
      onChange(value.map(input => input.source_row_id === row.source_row_id
        ? { ...input, material_code: code } : { ...input }));
    }}>
    {!options.some(option => option.material_code === selectedCode) && <option value={selectedCode} disabled>
      {selectedCode ? `${ko ? "확인 필요" : "待核对"}: ${selectedCode}` : (ko ? "선택값 확인 필요" : "需核对所选值")}
    </option>}
    {options.map(option => <option key={option.material_code} value={option.material_code}>
      {materialLabel(option)}{option.material_code === row.material_code ? (ko ? " (BOM 원본)" : "（BOM原料）") : ""}
    </option>)}
  </select>;
}

function materialAmounts(row: PlanBomSourceInput, source: PlanBomSource, props: PlanBomInputsProps) {
  const { quantity, value, onChange, disabled, ko } = props;
  const numerator = selectedPlanBomNumerator(row, value);
  const required = materialRequirement(quantity, numerator, row.denominator);
  const editable = canEditPlanBomRatio(row);
  return <>
    {editable ? <label className="plan-workflow__ratio"><span>{ko ? "개당 배합" : "每件配比"}</span>
      <input aria-label={`${ko ? "개당 원료 배합" : "每件原料配比"} ${row.material_code}`} inputMode="decimal"
        value={numerator} aria-invalid={required === null || !validNumerator(numerator)} disabled={disabled || !hasExactSourceRows(source, value)}
        onChange={event => { if (disabled || !hasExactSourceRows(source, value)) return;
          onChange(value.map(input => input.source_row_id === row.source_row_id
            ? { ...input, numerator: event.target.value } : { ...input })); }} />
      <span>{row.unit_name} / 1 {source.setup.output_unit_name}</span>
    </label> : <span className="plan-workflow__ratio">{row.numerator} {row.unit_name} / {row.denominator} {source.setup.output_unit_name}</span>}
    <span className={`plan-workflow__requirement${required === null ? " plan-workflow__blocked" : ""}`}>
      {ko ? "필요량 " : "需求量 "}{required === null ? (ko ? "확인 필요" : "待核对") : `${required} ${row.unit_name}`}
    </span>
  </>;
}

/** Place this editor in the material table cell; the primary row need not be the first BOM row. */
export function PlanBomPrimaryInput(props: PlanBomInputsProps & {
  onActivate?: () => void; idleLabel?: string; loading?: boolean; rowLabel?: string;
}) {
  const { source, ko } = props;
  const primary = source?.inputs.find(row => row.replaceable === true);
  if ((!source || source.inputs.length === 0) && !props.onActivate) return <span className="plan-workflow__blocked">
    {ko ? "BOM 확인 필요" : "需核对BOM"}
  </span>;
  if (!source || source.inputs.length === 0) return <div className="plan-workflow__material-summary" style={{ fontSize: 14 }}>
    <select aria-label={`${ko ? "원료 선택" : "选择原料"} ${props.rowLabel || ""}`.trim()}
      aria-busy={props.loading || undefined} value="" disabled={props.disabled || !props.onActivate}
      onFocus={props.onActivate} onChange={() => {}}>
      <option value="">{props.loading ? (ko ? "BOM 조회 중…" : "正在读取BOM…")
        : props.idleLabel || (ko ? "BOM 확인 필요" : "需核对BOM")}</option>
    </select>
  </div>;
  if (!primary) return <span>{ko ? "고정 자재만 사용" : "仅使用固定物料"}</span>;
  return <div className="plan-workflow__material-summary" data-source-row-id={primary.source_row_id} style={{ fontSize: 14 }}>
    {materialSelect(props, primary, source.inputs.indexOf(primary))}
  </div>;
}

export function PlanBomInputs(props: PlanBomInputsProps) {
  const { source, catalog, value, hidePrimary = false, ko } = props;
  if (!source || source.inputs.length === 0) return <p className="plan-workflow__blocked" role="alert">
    {ko ? "BOM을 불러오지 못했습니다. 다시 조회하세요." : "未能读取BOM，请重新查询。"}
  </p>;
  const valid = isPlanBomSelectionValid(source, catalog, value);
  const primary = hidePrimary ? source.inputs.find(row => row.replaceable === true) : undefined;
  return <div className="plan-workflow__bom-inputs" style={{ fontSize: 14 }}>
    {!valid && <p className="plan-workflow__blocked" role="alert">
      {ko ? "BOM 원본과 원료 선택값을 다시 확인하세요." : "请重新核对BOM原始行与所选原料。"}
    </p>}
    {source.inputs.map((row, index) => {
      return <div key={row.source_row_id} className="plan-workflow__input-row" data-source-row-id={row.source_row_id}>
        {row !== primary && row.replaceable === true ? <label className="plan-workflow__bom-material">
          <span>{index + 1}.</span>
          {materialSelect(props, row, index)}
        </label> : <span>{row === primary ? (ko ? "원료 배합" : "原料配比") : `${index + 1}. ${materialLabel(row)}`}</span>}
        {materialAmounts(row, source, props)}
      </div>;
    })}
  </div>;
}
