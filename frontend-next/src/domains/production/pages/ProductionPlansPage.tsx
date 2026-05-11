import { useEffect, useMemo, useState, type DragEvent, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getProductionPlanDates,
  getProductionPlanItems,
  updateProductionPlanItem,
  uploadProductionPlanFile,
  type PlanType,
  type ProductionPlanRecord,
} from "@/domains/production/api";
import { LoadingBlock } from "@/shared/components/LoadingBlock";
import { PageHeader } from "@/shared/components/PageHeader";
import { StatCard } from "@/shared/components/StatCard";
import { type AppLanguage, useStoredLanguage } from "@/shared/i18n/language";
import { getSeoulDateString } from "@/shared/utils/date";

type UploadStatus = {
  tone: "success" | "error";
  message: string;
};

type PlanEditDraft = {
  machine_name: string;
  part_no: string;
  model_name: string;
  lot_no: string;
  planned_quantity: string;
};

type MachinePlanGroup = {
  key: string;
  machineName: string;
  totalQty: number;
  records: ProductionPlanRecord[];
};

const processTypes: PlanType[] = ["injection", "machining"];

const pageCopy = {
  ko: {
    eyebrow: "생산관리",
    title: "생산 계획",
    description: "엑셀 업로드 · 일자별 사출/가공 계획",
    planDate: "계획일",
    process: "공정",
    injection: "사출",
    machining: "가공",
    plannedQty: "계획 수량",
    activeMachines: "설비/라인",
    planRows: "작업 행",
    totalHint: "선택한 날짜의 사출·가공 합계",
    machineHint: "계획이 배정된 설비와 라인",
    rowHint: "저장된 계획 상세 행",
    uploadTitle: "일자별 생산계획 업데이트",
    updateTarget: "업데이트 대상",
    updateMethod: "저장 방식",
    latestSheetRule: "파일 내 최신 날짜 시트",
    replaceRule: "선택한 파일의 공정만 새 파일 기준으로 교체됩니다.",
    uploadSection: "업로드",
    openUpload: "생산계획 업로드",
    close: "닫기",
    dashboardSection: "현황",
    machinesSection: "설비",
    modelsSection: "모델",
    detailsSection: "상세",
    injectionFile: "사출 계획 파일",
    machiningFile: "가공 계획 파일",
    uploadFile: "계획 파일",
    chooseFile: "파일 선택",
    dropFile: "파일을 여기에 끌어다 놓기",
    fileHint: "xlsx 또는 xls",
    uploadButton: "계획 업데이트",
    uploading: "업로드 중",
    noFile: "사출 또는 가공 계획 파일을 하나 이상 선택해주세요.",
    uploadSuccess: "업로드가 완료되었습니다.",
    uploadError: "업로드에 실패했습니다.",
    dashboardTitle: "일자별 계획 현황",
    dashboardMeta: "수량 · 설비/라인 · 작업 행",
    machineSummary: "설비별 계획",
    modelSummary: "모델별 계획",
    planDetails: "계획 상세",
    noMachineData: "설비별 계획이 없습니다.",
    noModelData: "모델별 계획이 없습니다.",
    noRows: "선택한 조건의 계획 행이 없습니다.",
    machine: "설비",
    partNo: "Part No",
    model: "모델",
    lot: "Lot",
    qty: "수량",
    action: "수정",
    edit: "수정",
    save: "저장",
    cancel: "취소",
    lineRow: "라인/행",
    unsetMachine: "미지정 설비",
    unsetModel: "모델 미지정",
  },
  zh: {
    eyebrow: "生产管理",
    title: "生产计划",
    description: "Excel 上传 · 每日注塑/加工计划",
    planDate: "计划日期",
    process: "工序",
    injection: "注塑",
    machining: "加工",
    plannedQty: "计划数量",
    activeMachines: "设备/产线",
    planRows: "作业行",
    totalHint: "所选日期的注塑·加工合计",
    machineHint: "已排计划的设备和产线",
    rowHint: "已保存的计划明细行",
    uploadTitle: "更新每日生产计划",
    updateTarget: "更新对象",
    updateMethod: "保存方式",
    latestSheetRule: "文件内最新日期工作表",
    replaceRule: "仅按已选择文件的工序替换现有计划。",
    uploadSection: "上传",
    openUpload: "上传生产计划",
    close: "关闭",
    dashboardSection: "现况",
    machinesSection: "设备",
    modelsSection: "型号",
    detailsSection: "明细",
    injectionFile: "注塑计划文件",
    machiningFile: "加工计划文件",
    uploadFile: "计划文件",
    chooseFile: "选择文件",
    dropFile: "将文件拖放到这里",
    fileHint: "xlsx 或 xls",
    uploadButton: "更新计划",
    uploading: "上传中",
    noFile: "请至少选择一个注塑或加工计划文件。",
    uploadSuccess: "上传完成。",
    uploadError: "上传失败。",
    dashboardTitle: "每日计划现况",
    dashboardMeta: "数量 · 设备/产线 · 作业行",
    machineSummary: "设备计划",
    modelSummary: "型号计划",
    planDetails: "计划明细",
    noMachineData: "暂无设备计划。",
    noModelData: "暂无型号计划。",
    noRows: "所选条件暂无计划行。",
    machine: "设备",
    partNo: "Part No",
    model: "型号",
    lot: "Lot",
    qty: "数量",
    action: "编辑",
    edit: "编辑",
    save: "保存",
    cancel: "取消",
    lineRow: "产线/行",
    unsetMachine: "未指定设备",
    unsetModel: "未指定型号",
  },
} satisfies Record<AppLanguage, Record<string, string>>;

function formatQuantity(value: number | null | undefined, language: AppLanguage) {
  return new Intl.NumberFormat(language === "ko" ? "ko-KR" : "zh-CN").format(
    Math.round(Number(value) || 0),
  );
}

function getProcessLabel(planType: PlanType, language: AppLanguage) {
  return pageCopy[language][planType];
}

function getMachineSortNumber(machineName: string) {
  const match = machineName.match(/-(\d+)\s*$/);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function buildMachineGroups(records: ProductionPlanRecord[], unsetMachineLabel: string, planType: PlanType) {
  const groupMap = new Map<string, MachinePlanGroup>();

  for (const record of records) {
    const machineName = record.machine_name || unsetMachineLabel;
    const current = groupMap.get(machineName) ?? {
      key: machineName,
      machineName,
      records: [],
      totalQty: 0,
    };

    current.records.push(record);
    current.totalQty += Number(record.planned_quantity) || 0;
    groupMap.set(machineName, current);
  }

  return [...groupMap.values()].sort((left, right) => {
    if (planType === "injection") {
      const leftMachineNumber = getMachineSortNumber(left.machineName);
      const rightMachineNumber = getMachineSortNumber(right.machineName);
      if (leftMachineNumber !== rightMachineNumber) {
        return leftMachineNumber - rightMachineNumber;
      }
    }

    return left.machineName.localeCompare(right.machineName, "ko-KR", {
      numeric: true,
      sensitivity: "base",
    });
  });
}

function getErrorMessage(error: unknown, fallback: string) {
  if (typeof error === "object" && error && "response" in error) {
    const response = (error as { response?: { data?: { detail?: string; error?: string } } }).response;
    return response?.data?.detail || response?.data?.error || fallback;
  }
  return error instanceof Error ? error.message : fallback;
}

export function ProductionPlansPage() {
  const queryClient = useQueryClient();
  const [language] = useStoredLanguage();
  const copy = pageCopy[language];
  const [selectedDate, setSelectedDate] = useState(getSeoulDateString());
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [injectionFile, setInjectionFile] = useState<File | null>(null);
  const [machiningFile, setMachiningFile] = useState<File | null>(null);
  const [dragTarget, setDragTarget] = useState<PlanType | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus | null>(null);
  const [editingRowId, setEditingRowId] = useState<number | null>(null);
  const [expandedMachines, setExpandedMachines] = useState<Set<string>>(new Set());
  const [editDraft, setEditDraft] = useState<PlanEditDraft>({
    machine_name: "",
    part_no: "",
    model_name: "",
    lot_no: "",
    planned_quantity: "",
  });

  const datesQuery = useQuery({
    queryKey: ["production", "plan-dates"],
    queryFn: getProductionPlanDates,
  });

  const dateOptions = useMemo(() => {
    return [
      ...new Set([
        selectedDate,
        ...(datesQuery.data?.injection ?? []),
        ...(datesQuery.data?.machining ?? []),
      ]),
    ]
      .filter(Boolean)
      .sort()
      .reverse();
  }, [datesQuery.data, selectedDate]);

  useEffect(() => {
    if (!datesQuery.data) return;
    const allDates = [...datesQuery.data.injection, ...datesQuery.data.machining].sort().reverse();
    if (!allDates.length) return;
    if (!allDates.includes(selectedDate)) {
      setSelectedDate(allDates[0]);
    }
  }, [datesQuery.data, selectedDate]);

  const injectionItemsQuery = useQuery({
    queryKey: ["production", "plan-items", selectedDate, "injection"],
    queryFn: () => getProductionPlanItems(selectedDate, "injection"),
    enabled: Boolean(selectedDate),
  });

  const machiningItemsQuery = useQuery({
    queryKey: ["production", "plan-items", selectedDate, "machining"],
    queryFn: () => getProductionPlanItems(selectedDate, "machining"),
    enabled: Boolean(selectedDate),
  });

  const uploadMutation = useMutation({
    mutationFn: async () => {
      const uploads: Array<{ file: File; planType: PlanType }> = [];
      if (injectionFile) uploads.push({ file: injectionFile, planType: "injection" });
      if (machiningFile) uploads.push({ file: machiningFile, planType: "machining" });

      if (!uploads.length) throw new Error(copy.noFile);

      const responses = [];
      for (const upload of uploads) {
        responses.push(await uploadProductionPlanFile(upload.file, upload.planType, selectedDate));
      }
      return { responses };
    },
    onSuccess: async ({ responses }) => {
      const response = responses[0];
      const nextDate = response.available_days?.[0] || response.target_date || response.plan_date || selectedDate;
      setSelectedDate(nextDate);
      setInjectionFile(null);
      setMachiningFile(null);
      setFileInputKey((value) => value + 1);
      setIsUploadModalOpen(false);
      setUploadStatus({ tone: "success", message: copy.uploadSuccess });
      await queryClient.invalidateQueries({ queryKey: ["production"] });
    },
    onError: (error) => {
      setUploadStatus({ tone: "error", message: getErrorMessage(error, copy.uploadError) });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (variables: { id: number; planType: PlanType; updates: PlanEditDraft }) => {
      return updateProductionPlanItem(selectedDate, variables.planType, variables.id, {
        machine_name: variables.updates.machine_name || null,
        part_no: variables.updates.part_no || null,
        model_name: variables.updates.model_name || null,
        lot_no: variables.updates.lot_no || null,
        planned_quantity: Number(variables.updates.planned_quantity) || 0,
      });
    },
    onSuccess: async () => {
      setEditingRowId(null);
      await queryClient.invalidateQueries({ queryKey: ["production"] });
    },
  });

  const injectionItems = injectionItemsQuery.data ?? [];
  const machiningItems = machiningItemsQuery.data ?? [];
  const totalInjectionQty = injectionItems.reduce((sum, row) => sum + (Number(row.planned_quantity) || 0), 0);
  const totalMachiningQty = machiningItems.reduce((sum, row) => sum + (Number(row.planned_quantity) || 0), 0);
  const injectionMachineGroups = buildMachineGroups(injectionItems, copy.unsetMachine, "injection");
  const machiningMachineGroups = buildMachineGroups(machiningItems, copy.unsetMachine, "machining");
  const totalPlanQty = totalInjectionQty + totalMachiningQty;
  const totalMachines = injectionMachineGroups.length + machiningMachineGroups.length;
  const totalRows = injectionItems.length + machiningItems.length;

  function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setUploadStatus(null);
    uploadMutation.mutate();
  }

  function handleFileDrop(event: DragEvent<HTMLDivElement>, planType: PlanType) {
    event.preventDefault();
    event.stopPropagation();
    setDragTarget(null);

    const file = event.dataTransfer.files?.[0];
    if (!file) return;

    if (planType === "injection") {
      setInjectionFile(file);
      return;
    }

    setMachiningFile(file);
  }

  function startEditingPlanRow(row: ProductionPlanRecord) {
    if (!row.id) return;
    setEditingRowId(row.id);
    setEditDraft({
      machine_name: row.machine_name || "",
      part_no: row.part_no || "",
      model_name: row.model_name || row.part_spec || "",
      lot_no: row.lot_no || "",
      planned_quantity: String(row.planned_quantity ?? 0),
    });
  }

  function updateEditDraft(key: keyof PlanEditDraft, value: string) {
    setEditDraft((current) => ({ ...current, [key]: value }));
  }

  function savePlanRow(id: number, planType: PlanType) {
    updateMutation.mutate({ id, planType, updates: editDraft });
  }

  function toggleMachineGroup(planType: PlanType, machineKey: string) {
    const expandedKey = `${planType}:${machineKey}`;
    setExpandedMachines((current) => {
      const next = new Set(current);
      if (next.has(expandedKey)) {
        next.delete(expandedKey);
      } else {
        next.add(expandedKey);
      }
      return next;
    });
  }

  function renderPlanRow(item: ProductionPlanRecord, planType: PlanType, index: number) {
    const isEditing = item.id === editingRowId;

    return (
      <div
        className={`machine-detail-row${isEditing ? " machine-detail-row--editing" : ""}`}
        key={`${item.id ?? index}-${item.machine_name}-${item.part_no}-${item.lot_no}`}
      >
        {isEditing ? (
          <>
            <input
              className="table-input"
              onChange={(event) => updateEditDraft("machine_name", event.target.value)}
              value={editDraft.machine_name}
            />
            <input
              className="table-input"
              onChange={(event) => updateEditDraft("part_no", event.target.value)}
              value={editDraft.part_no}
            />
            <input
              className="table-input"
              onChange={(event) => updateEditDraft("model_name", event.target.value)}
              value={editDraft.model_name}
            />
            <input
              className="table-input"
              onChange={(event) => updateEditDraft("lot_no", event.target.value)}
              value={editDraft.lot_no}
            />
            <input
              className="table-input"
              inputMode="numeric"
              onChange={(event) => updateEditDraft("planned_quantity", event.target.value)}
              value={editDraft.planned_quantity}
            />
            <div className="plan-row-actions">
              <button
                className="button button--mini button--primary"
                disabled={updateMutation.isPending}
                onClick={() => item.id && savePlanRow(item.id, planType)}
                type="button"
              >
                {copy.save}
              </button>
              <button
                className="button button--mini button--ghost"
                onClick={() => setEditingRowId(null)}
                type="button"
              >
                {copy.cancel}
              </button>
            </div>
          </>
        ) : (
          <>
            <span>{item.machine_name || copy.unsetMachine}</span>
            <span>{item.part_no || "-"}</span>
            <span>{item.model_name || item.part_spec || "-"}</span>
            <span>{item.lot_no || "-"}</span>
            <span>{formatQuantity(item.planned_quantity, language)}</span>
            <div className="plan-row-actions">
              <button
                className="button button--mini button--ghost"
                disabled={!item.id}
                onClick={() => startEditingPlanRow(item)}
                type="button"
              >
                {copy.edit}
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  function renderProcessColumn(planType: PlanType, groups: MachinePlanGroup[], totalQty: number, rowCount: number) {
    return (
      <section className="process-column">
        <div className="process-column__header">
          <div>
            <p className="panel-card__eyebrow">{getProcessLabel(planType, language)}</p>
            <h3 className="panel__title">{formatQuantity(totalQty, language)}</h3>
          </div>
          <span>{groups.length} {copy.activeMachines} · {rowCount} {copy.planRows}</span>
        </div>

        <div className="machine-group-list">
          {groups.length ? (
            groups.map((group) => {
              const expandedKey = `${planType}:${group.key}`;
              const isExpanded = expandedMachines.has(expandedKey);

              return (
                <article className="machine-group" key={expandedKey}>
                  <button
                    className={`machine-group__summary${isExpanded ? " machine-group__summary--active" : ""}`}
                    onClick={() => toggleMachineGroup(planType, group.key)}
                    type="button"
                  >
                    <div>
                      <strong>{group.machineName}</strong>
                      <p>{group.records.length} {copy.planRows}</p>
                    </div>
                    <div className="machine-group__qty">
                      <span>{formatQuantity(group.totalQty, language)}</span>
                      <small>{isExpanded ? "▲" : "▼"}</small>
                    </div>
                  </button>

                  {isExpanded ? (
                    <div className="machine-detail-table">
                      <div className="machine-detail-row machine-detail-row--head">
                        <span>{copy.machine}</span>
                        <span>{copy.partNo}</span>
                        <span>{copy.model}</span>
                        <span>{copy.lot}</span>
                        <span>{copy.qty}</span>
                        <span>{copy.action}</span>
                      </div>
                      {group.records.map((row, index) => renderPlanRow(row, planType, index))}
                    </div>
                  ) : null}
                </article>
              );
            })
          ) : (
            <div className="notice notice--neutral">{copy.noMachineData}</div>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="page">
      <PageHeader eyebrow={copy.eyebrow} title={copy.title} description={copy.description} />

      <div className="plan-toolbar">
        <div className="plan-toolbar__section">
          <label className="field">
            <span>{copy.planDate}</span>
            <select
              className="input"
              onChange={(event) => {
                setSelectedDate(event.target.value);
              }}
              value={selectedDate}
            >
              {dateOptions.map((date) => (
                <option key={date} value={date}>
                  {date}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="plan-toolbar__section plan-toolbar__actions">
          <button
            className="button button--primary"
            onClick={() => {
              setUploadStatus(null);
              setIsUploadModalOpen(true);
            }}
            type="button"
          >
            {copy.openUpload}
          </button>
        </div>
      </div>

      {uploadStatus ? (
        <div className={`notice ${uploadStatus.tone === "success" ? "notice--success" : "notice--warning"}`}>
          {uploadStatus.message}
        </div>
      ) : null}

      {datesQuery.isLoading || injectionItemsQuery.isLoading || machiningItemsQuery.isLoading ? (
        <LoadingBlock label={language === "ko" ? "생산 계획을 불러오는 중입니다." : "正在加载生产计划。"} />
      ) : null}

      <div className="stats-grid">
        <StatCard title={copy.plannedQty} value={formatQuantity(totalPlanQty, language)} hint={copy.totalHint} />
        <StatCard title={copy.activeMachines} value={String(totalMachines)} hint={copy.machineHint} />
        <StatCard title={copy.planRows} value={String(totalRows)} hint={copy.rowHint} />
      </div>

      <section className="panel">
        <div className="plan-table-header">
          <div>
            <p className="panel-card__eyebrow">{copy.dashboardSection}</p>
            <h3 className="panel__title">{copy.dashboardTitle}</h3>
          </div>
          <span className="plan-table-header__meta">{selectedDate}</span>
        </div>
        <p className="plan-dashboard__meta">{copy.dashboardMeta}</p>

        <div className="process-plan-grid">
          {renderProcessColumn("injection", injectionMachineGroups, totalInjectionQty, injectionItems.length)}
          {renderProcessColumn("machining", machiningMachineGroups, totalMachiningQty, machiningItems.length)}
        </div>
      </section>

      {isUploadModalOpen ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal-card" aria-modal="true" role="dialog">
            <div className="modal-card__header">
              <div>
                <p className="panel-card__eyebrow">{copy.uploadSection}</p>
                <h3 className="panel__title">{copy.uploadTitle}</h3>
              </div>
              <button
                className="button button--ghost"
                onClick={() => setIsUploadModalOpen(false)}
                type="button"
              >
                {copy.close}
              </button>
            </div>

            <form className="plan-upload-form" onSubmit={handleUpload}>
              <div className="plan-update-summary">
                <div>
                  <span>{copy.updateTarget}</span>
                  <strong>{copy.latestSheetRule} · {copy.injection} / {copy.machining}</strong>
                </div>
                <div>
                  <span>{copy.updateMethod}</span>
                  <strong>{copy.replaceRule}</strong>
                </div>
              </div>

              <label className="field plan-file-field">
                <span>{copy.injectionFile}</span>
                <input
                  accept=".xlsx,.xls"
                  key={`injection-${fileInputKey}`}
                  onChange={(event) => setInjectionFile(event.target.files?.[0] ?? null)}
                  type="file"
                />
                <div
                  className={`plan-file-field__drop${dragTarget === "injection" ? " plan-file-field__drop--active" : ""}`}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    setDragTarget("injection");
                  }}
                  onDragLeave={(event) => {
                    event.preventDefault();
                    setDragTarget(null);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragTarget("injection");
                  }}
                  onDrop={(event) => handleFileDrop(event, "injection")}
                >
                  <strong>{injectionFile?.name || copy.chooseFile}</strong>
                  <span>{dragTarget === "injection" ? copy.dropFile : copy.fileHint}</span>
                </div>
              </label>

              <label className="field plan-file-field">
                <span>{copy.machiningFile}</span>
                <input
                  accept=".xlsx,.xls"
                  key={`machining-${fileInputKey}`}
                  onChange={(event) => setMachiningFile(event.target.files?.[0] ?? null)}
                  type="file"
                />
                <div
                  className={`plan-file-field__drop${dragTarget === "machining" ? " plan-file-field__drop--active" : ""}`}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    setDragTarget("machining");
                  }}
                  onDragLeave={(event) => {
                    event.preventDefault();
                    setDragTarget(null);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragTarget("machining");
                  }}
                  onDrop={(event) => handleFileDrop(event, "machining")}
                >
                  <strong>{machiningFile?.name || copy.chooseFile}</strong>
                  <span>{dragTarget === "machining" ? copy.dropFile : copy.fileHint}</span>
                </div>
              </label>

              {uploadStatus?.tone === "error" ? (
                <div className="notice notice--warning">{uploadStatus.message}</div>
              ) : null}

              <button className="button button--primary button--wide" disabled={uploadMutation.isPending} type="submit">
                {uploadMutation.isPending ? copy.uploading : copy.uploadButton}
              </button>
            </form>
          </section>
        </div>
      ) : null}

    </section>
  );
}
