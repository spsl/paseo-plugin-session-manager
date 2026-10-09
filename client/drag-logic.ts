/** Pure drop resolution for the board drag-and-drop. */
import { canDrop, statusForColumn } from "../shared/drop-target";
import type { AnalysisStatus, BoardColumn, SessionView } from "../shared/types";

export type DropResolution =
  | { kind: "drop"; status: AnalysisStatus }
  | { kind: "reject"; message: string }
  | { kind: "noop" };

export const CLOSED_DROP_MESSAGE = "已关闭列不能拖入";

export function resolveDrop(session: SessionView, target: BoardColumn | null): DropResolution {
  if (target === null) {
    return { kind: "noop" };
  }
  if (target === "closed") {
    // Dropping a closed card back on its own column is a no-op.
    return session.column === "closed"
      ? { kind: "noop" }
      : { kind: "reject", message: CLOSED_DROP_MESSAGE };
  }
  const status = statusForColumn(target);
  if (status === null || !canDrop(session, target)) {
    return { kind: "noop" };
  }
  return { kind: "drop", status };
}
