import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation } from "@tanstack/react-query";
import { useLang } from "@/i18n";
import {
  postMesTaskActions,
  type MesTaskActionItem,
  type MesTaskActionResult,
} from "@/domains/production/mes-task-actions-api";

type MesTaskActionDialogProps = {
  title: string;
  items: MesTaskActionItem[];
  onClose: (changed: boolean) => void;
};

const REASON_PRESETS = ["planOutside", "partChange", "productionDone", "planStart"] as const;

export function MesTaskActionDialog({ title, items, onClose }: MesTaskActionDialogProps) {
  const { t } = useLang();
  const text = (key: string) => t(`machineBoard.action.${key}`);
  const mesText = (key: string) => t(`mesTasks.${key}`);
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const [preset, setPreset] = useState<(typeof REASON_PRESETS)[number] | "other">(
    items.every((item) => item.action === "start" || item.action === "resume") ? "planStart" : "planOutside",
  );
  const [otherReason, setOtherReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const mutation = useMutation({
    mutationFn: (reason: string) => postMesTaskActions(items, reason),
  });
  const results = mutation.data?.results;
  const reason = preset === "other" ? otherReason.trim() : text(`reason.${preset}`);
  const closesWorkOrders = items.some((item) => item.action === "close_work_order");
  const canSubmit = Boolean(reason) && reason.length <= 200 && acknowledged && !mutation.isPending && !results;

  useEffect(() => {
    dialogRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !mutation.isPending) onClose(Boolean(results));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mutation.isPending, onClose, results]);

  function resultFor(item: MesTaskActionItem): MesTaskActionResult | undefined {
    return results?.find((result) => result.task_id === item.task_id);
  }

  function errorText() {
    const error = mutation.error as { response?: { status?: number; data?: { code?: string } } } | null;
    const status = error?.response?.status;
    if (status === 409) return text("errorDisabled");
    if (status === 403) return text("errorPermission");
    if (status === 400) return text("errorInvalid");
    return text("errorUnknown");
  }

  return createPortal(
    <div className="modal-backdrop machine-action-backdrop" role="presentation" onClick={() => !mutation.isPending && onClose(Boolean(results))}>
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="modal-card machine-action-dialog"
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="machine-action-dialog__header">
          <h3 className="panel__title" id={titleId}>{title}</h3>
          <p>{results ? text("doneHint") : text("confirmHint")}</p>
        </header>

        <div className="machine-board__table-wrap">
          <table className="machine-board__tasks">
            <thead>
              <tr>
                <th scope="col">{t("machineBoard.colMachine")}</th>
                <th scope="col">{t("machineBoard.taskPart")}</th>
                <th scope="col">{text("change")}</th>
                {results ? <th scope="col">{text("result")}</th> : null}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const result = resultFor(item);
                return (
                  <tr key={item.task_id}>
                    <td>{item.machine_number}{mesText("machineUnit")}</td>
                    <td>
                      <strong>{item.part_no || "—"}</strong>
                      <small>{item.task_code} · {item.work_order_code || "—"}</small>
                    </td>
                    <td>
                      {mesText(`status.${item.expected_status}`)} → <strong>{text(`kind.${item.action}`)}</strong>
                    </td>
                    {results ? (
                      <td>
                        <span className={`machine-board__badge machine-board__badge--${result?.outcome === "confirmed" ? "ok" : "warning"}`}>
                          {result ? text(`outcome.${result.outcome}`) : text("outcome.uncertain")}
                        </span>
                        {result?.reason ? <small>{text(`why.${result.reason}`)}</small> : null}
                        {result?.mes_message ? <small>MES: {result.mes_message}</small> : null}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {!results ? (
          <div className="machine-action-dialog__form">
            {closesWorkOrders ? <p className="machine-board__notice">{text("closeWarning")}</p> : null}
            <fieldset>
              <legend>{text("reasonLabel")}</legend>
              {REASON_PRESETS.map((value) => (
                <label key={value}>
                  <input checked={preset === value} name="mes-action-reason" onChange={() => setPreset(value)} type="radio" />
                  {text(`reason.${value}`)}
                </label>
              ))}
              <label>
                <input checked={preset === "other"} name="mes-action-reason" onChange={() => setPreset("other")} type="radio" />
                {text("reason.other")}
              </label>
              {preset === "other" ? (
                <input
                  aria-label={text("reason.other")}
                  className="machine-action-dialog__other"
                  maxLength={200}
                  onChange={(event) => setOtherReason(event.target.value)}
                  value={otherReason}
                />
              ) : null}
            </fieldset>
            <label className="machine-action-dialog__ack">
              <input checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} type="checkbox" />
              {text("acknowledge")}
            </label>
            {mutation.isError ? <p className="machine-board__notice" role="alert">{errorText()}</p> : null}
          </div>
        ) : (
          <p className="machine-board__muted">{text("uncertainHint")}</p>
        )}

        <footer className="machine-action-dialog__footer">
          <button className="button button--ghost" disabled={mutation.isPending} onClick={() => onClose(Boolean(results))} type="button">
            {results ? text("close") : text("cancel")}
          </button>
          {!results ? (
            <button className="button button--primary" disabled={!canSubmit} onClick={() => mutation.mutate(reason)} type="button">
              {mutation.isPending ? text("running") : `${text("run")} (${items.length})`}
            </button>
          ) : null}
        </footer>
      </section>
    </div>,
    document.body,
  );
}
