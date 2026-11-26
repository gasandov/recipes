import type { Amount, MeasuredAmount, UnitId } from "../contracts";
import { defaultMetricUnit, formatMeasuredAmount, formatRational } from "../domain";
import { unitLabel } from "../ui/text";
import { getProgress, isChecked } from "./workflow";
import type { MeasuredLine, ShoppingGroup, ShoppingState } from "./workflow";

export function preferredUnit(line: MeasuredLine): UnitId {
  return line.total.preferredUnit ?? defaultMetricUnit(line.total.amount);
}

const decimalUnit = (unit: UnitId) => unit === "kilogram" || unit === "liter";

export function formatQuantity(amount: MeasuredAmount): string {
  return `${formatMeasuredAmount(amount, decimalUnit(amount.unit))} ${unitLabel(amount.unit, amount.max ?? amount.min)}`;
}

export function formatManualAmount(amount: Amount): string {
  if (amount.kind === "measured") return formatQuantity(amount);
  return amount.kind === "qualitative" ? amount.text : "Sin cantidad";
}

type Progress = ReturnType<typeof getProgress>;

export function getRemainingDisplay(state: ShoppingState, line: MeasuredLine, unit?: UnitId): Progress {
  const requested = unit ?? line.total.preferredUnit;
  if (requested) return getProgress(state, line, requested);
  const base = getProgress(state, line);
  if (!base.outstanding) return base;
  const metric = defaultMetricUnit({ kind: "measured", min: base.outstanding, unit: base.required.unit });
  return metric === base.required.unit ? base : getProgress(state, line, metric);
}

export function formatRemaining(progress: Progress): string {
  if (!progress.outstanding) return "0";
  const unit = progress.required.unit;
  const format = (value: Parameters<typeof formatRational>[0]) => formatRational(value, decimalUnit(unit));
  const min = progress.min ? format(progress.min) : "0";
  const quantity = progress.max ? `${min}–${format(progress.max)}` : min;
  return `${progress.approximate ? "≈ " : ""}${quantity} ${unitLabel(unit, progress.outstanding)}`;
}

/** Produces a point-in-time list of items still to buy. */
export function createShoppingSnapshot(groups: readonly ShoppingGroup[], state: ShoppingState): string {
  const pending: string[] = [];
  for (const group of groups) {
    for (const line of group.lines) {
      if (line.kind === "measured") {
        const progress = getRemainingDisplay(state, line);
        if (progress.outstanding) pending.push(`• ${group.name} — ${formatRemaining(progress)}`);
      } else if (!isChecked(state, line)) {
        pending.push(`• ${group.name} — ${line.note ?? "Sin cantidad"}`);
      }
    }
  }
  return ["Lista de compras", "", ...(pending.length ? pending : ["No quedan compras pendientes."])].join("\n");
}
