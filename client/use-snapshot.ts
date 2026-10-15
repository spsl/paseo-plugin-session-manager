/**
 * Snapshot polling, detail loading and optimistic mutations.
 * Async function expressions only (Hermes eval); no closures inside for...of.
 */
import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import {
  applyGeneratedTitleRpc,
  clearDeferRpc,
  clearManualStatusRpc,
  deferRpc,
  detailRpc,
  dismissResumeRpc,
  forgetRpc,
  reanalyzeRpc,
  reopenRpc,
  resumeRpc,
  reviewDismissRpc,
  reviewRequestRpc,
  setManualStatusRpc,
  snapshotRpc,
} from "../shared/rpc";
import type { AnalysisStatus } from "../shared/types";
import {
  patchClearDefer,
  patchClearManualStatus,
  patchDefer,
  patchDeferEndSeen,
  patchDismissResume,
  patchForget,
  patchManualStatus,
  patchReanalyze,
  patchReopen,
  patchResume,
  pollIntervalFor,
} from "./board-model";

export type SnapshotData = RpcOutput<typeof snapshotRpc>;
export type DetailData = RpcOutput<typeof detailRpc>;

export const SNAPSHOT_QUERY_KEY = ["session-manager", "snapshot"] as const;
const DETAIL_QUERY_KEY = ["session-manager", "detail"] as const;

/** Last snapshot loaded, so remounting screens repaint before the first load answers. */
let lastSnapshot: SnapshotData | null = null;

export function useSnapshot() {
  const load = useRpc(snapshotRpc);
  return useQuery({
    queryKey: SNAPSHOT_QUERY_KEY,
    queryFn: async function loadSnapshot(): Promise<SnapshotData> {
      const snapshot = await load({});
      lastSnapshot = snapshot;
      return snapshot;
    },
    refetchInterval: function interval(query) {
      return pollIntervalFor(query.state.data);
    },
    ...(lastSnapshot === null ? {} : { placeholderData: lastSnapshot }),
  });
}

/** `awaitingNew` polls fast until a just-created session shows up. */
export function useDetail(sessionId: string | null, awaitingNew = false) {
  const load = useRpc(detailRpc);
  return useQuery({
    queryKey: [...DETAIL_QUERY_KEY, sessionId],
    enabled: sessionId !== null,
    queryFn: async function loadDetail(): Promise<DetailData> {
      return load({ sessionId: sessionId ?? "" });
    },
    refetchInterval: function interval(query) {
      return awaitingNew && !query.state.data?.session ? 500 : 5_000;
    },
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function patchCache(
  queryClient: QueryClient,
  patch: (snapshot: SnapshotData) => SnapshotData,
): void {
  queryClient.setQueryData<SnapshotData>(SNAPSHOT_QUERY_KEY, function update(current) {
    if (!current) {
      return current;
    }
    const next = patch(current);
    lastSnapshot = next;
    return next;
  });
}

async function refresh(queryClient: QueryClient, sessionId: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: SNAPSHOT_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: [...DETAIL_QUERY_KEY, sessionId] }),
  ]);
}

/**
 * Optimistically drops the "延迟已结束" marker once the card is opened; the
 * server already acknowledged it in the detail call, this skips the poll wait.
 */
export function markDeferEndSeen(queryClient: QueryClient, sessionId: string): void {
  patchCache(queryClient, function patch(snapshot) {
    return patchDeferEndSeen(snapshot, sessionId);
  });
}

export type SessionActions = {
  setManualStatus(sessionId: string, status: AnalysisStatus): Promise<boolean>;
  clearManualStatus(sessionId: string): Promise<boolean>;
  defer(sessionId: string, durationMs: number, toQueue: boolean): Promise<boolean>;
  clearDefer(sessionId: string): Promise<boolean>;
  reanalyze(sessionId: string): Promise<boolean>;
  applyGeneratedTitle(sessionId: string): Promise<boolean>;
  forget(sessionId: string): Promise<boolean>;
  resume(sessionId: string): Promise<boolean>;
  dismissResume(sessionId: string): Promise<boolean>;
  reopen(sessionId: string): Promise<boolean>;
  /** Sends the (possibly user-edited) review request into the session. */
  requestReview(sessionId: string, text: string): Promise<boolean>;
  dismissReview(sessionId: string): Promise<boolean>;
};

export function useSessionActions(): SessionActions {
  const queryClient = useQueryClient();
  const toast = useToast();
  const setStatus = useRpc(setManualStatusRpc);
  const clearStatus = useRpc(clearManualStatusRpc);
  const deferCall = useRpc(deferRpc);
  const clearDeferCall = useRpc(clearDeferRpc);
  const reanalyzeCall = useRpc(reanalyzeRpc);
  const applyTitle = useRpc(applyGeneratedTitleRpc);
  const forgetCall = useRpc(forgetRpc);
  const resumeCall = useRpc(resumeRpc);
  const dismissResumeCall = useRpc(dismissResumeRpc);
  const reopenCall = useRpc(reopenRpc);
  const reviewRequestCall = useRpc(reviewRequestRpc);
  const reviewDismissCall = useRpc(reviewDismissRpc);

  const run = useCallback(
    async function run(
      sessionId: string,
      failurePrefix: string,
      optimistic: ((snapshot: SnapshotData) => SnapshotData) | null,
      call: () => Promise<{ ok: boolean; reason?: string }>,
    ): Promise<boolean> {
      if (optimistic) {
        await queryClient.cancelQueries({ queryKey: SNAPSHOT_QUERY_KEY });
        patchCache(queryClient, optimistic);
      }
      try {
        const result = await call();
        if (!result.ok) {
          toast.error(`${failurePrefix}：${result.reason ?? "未知原因"}`);
        }
        await refresh(queryClient, sessionId);
        return result.ok;
      } catch (error) {
        toast.error(`${failurePrefix}：${errorText(error)}`);
        await refresh(queryClient, sessionId);
        return false;
      }
    },
    [queryClient, toast],
  );

  return useMemo(
    function build(): SessionActions {
      return {
        setManualStatus(sessionId, status) {
          return run(
            sessionId,
            "状态更新失败",
            function optimistic(snapshot) {
              return patchManualStatus(snapshot, sessionId, status);
            },
            function call() {
              return setStatus({ sessionId, status });
            },
          );
        },
        clearManualStatus(sessionId) {
          return run(
            sessionId,
            "状态更新失败",
            function optimistic(snapshot) {
              return patchClearManualStatus(snapshot, sessionId);
            },
            function call() {
              return clearStatus({ sessionId });
            },
          );
        },
        defer(sessionId, durationMs, toQueue) {
          return run(
            sessionId,
            "延迟设置失败",
            function optimistic(snapshot) {
              return patchDefer(snapshot, sessionId, Date.now() + durationMs, toQueue);
            },
            function call() {
              return deferCall({ sessionId, durationMs, toQueue });
            },
          );
        },
        clearDefer(sessionId) {
          return run(
            sessionId,
            "恢复显示失败",
            function optimistic(snapshot) {
              return patchClearDefer(snapshot, sessionId);
            },
            function call() {
              return clearDeferCall({ sessionId });
            },
          );
        },
        reanalyze(sessionId) {
          return run(
            sessionId,
            "重新分析失败",
            function optimistic(snapshot) {
              return patchReanalyze(snapshot, sessionId);
            },
            function call() {
              return reanalyzeCall({ sessionId });
            },
          );
        },
        applyGeneratedTitle(sessionId) {
          return run(sessionId, "应用标题失败", null, function call() {
            return applyTitle({ sessionId });
          });
        },
        forget(sessionId) {
          return run(
            sessionId,
            "移除失败",
            function optimistic(snapshot) {
              return patchForget(snapshot, sessionId);
            },
            function call() {
              return forgetCall({ sessionId });
            },
          );
        },
        resume(sessionId) {
          return run(
            sessionId,
            "恢复失败",
            function optimistic(snapshot) {
              return patchResume(snapshot, sessionId);
            },
            function call() {
              return resumeCall({ sessionId });
            },
          );
        },
        dismissResume(sessionId) {
          return run(
            sessionId,
            "操作失败",
            function optimistic(snapshot) {
              return patchDismissResume(snapshot, sessionId);
            },
            function call() {
              return dismissResumeCall({ sessionId });
            },
          );
        },
        reopen(sessionId) {
          return run(
            sessionId,
            "重新打开失败",
            function optimistic(snapshot) {
              return patchReopen(snapshot, sessionId);
            },
            function call() {
              return reopenCall({ sessionId });
            },
          );
        },
        requestReview(sessionId, text) {
          return run(sessionId, "发送审查请求失败", null, function call() {
            return reviewRequestCall({ sessionId, text });
          });
        },
        dismissReview(sessionId) {
          return run(sessionId, "忽略建议失败", null, function call() {
            return reviewDismissCall({ sessionId });
          });
        },
      };
    },
    [
      run,
      setStatus,
      clearStatus,
      deferCall,
      clearDeferCall,
      reanalyzeCall,
      applyTitle,
      forgetCall,
      resumeCall,
      dismissResumeCall,
      reopenCall,
      reviewRequestCall,
      reviewDismissCall,
    ],
  );
}
