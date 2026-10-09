/** Pure drag-and-drop helpers for the board. */
import type { AnalysisStatus, BoardColumn, SessionView } from "./types";

export type ColumnRect = {
  id: BoardColumn;
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Returns the column whose rectangle contains the point, or null. */
export function hitTestColumn(
  rects: readonly ColumnRect[],
  x: number,
  y: number,
): BoardColumn | null {
  for (const rect of rects) {
    if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
      return rect.id;
    }
  }
  return null;
}

/** The manual status a drop on the column means; the closed column is not a status. */
export function statusForColumn(column: BoardColumn): AnalysisStatus | null {
  return column === "closed" ? null : column;
}

export function canDrop(session: SessionView, column: BoardColumn): boolean {
  if (session.liveness !== "live") {
    return false;
  }
  const status = statusForColumn(column);
  if (status === null) {
    return false;
  }
  // Dropping on the current column is a no-op.
  if (session.column === column) {
    return false;
  }
  if (session.manualStatusOverride === null && session.effectiveStatus === status) {
    return false;
  }
  return true;
}
