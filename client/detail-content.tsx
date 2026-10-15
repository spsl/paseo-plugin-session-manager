import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import {
  analysisStateLabel,
  branchLabel,
  confidenceLabel,
  firstLine,
  formatDeferRemaining,
  formatDeferUntil,
  formatStepTime,
  latestRunNote,
  lifecycleLabel,
  livenessLabel,
  nowLine,
  STATUS_OPTIONS,
  workspaceLabel,
  type LiveState,
  type NowTone,
} from "../shared/presentation";
import {
  DECLARED_KIND_LABELS,
  isActiveLiveness,
  type AnalysisRunSummary,
  type FlowTurn,
  type SessionDetail,
  type Turn,
} from "../shared/types";
import { flowGetRpc } from "../shared/rpc";
import { AnalysisRunDialog, type AnalysisRunTarget } from "./analysis-run-dialog";
import { Badge, Chip } from "./badge";
import { Markdown } from "./markdown/markdown";
import { MermaidBlock } from "./markdown/mermaid-block";
import { ReviewRequestDialog } from "./review-dialog";
import { declaredTone, errorText, formatDateTime, statusTone } from "./styles";
import { SNAPSHOT_QUERY_KEY, useSessionActions } from "./use-snapshot";

/** Only unusual outcomes are marked; a completed turn shows just its input. */
const OUTCOME_MARKS: Partial<Record<Turn["outcome"], string>> = {
  failed: "失败",
  canceled: "已取消",
};

function Section(props: { theme: PluginTheme; title: string; trailing?: ReactNode; children: ReactNode }) {
  const { colors } = props.theme;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ flex: 1, color: colors.foreground, fontSize: 13, fontWeight: "600" }}>
          {props.title}
        </Text>
        {props.trailing}
      </View>
      {props.children}
    </View>
  );
}

function Field(props: { theme: PluginTheme; label: string; value: string }) {
  const { colors } = props.theme;
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <Text style={{ width: 80, color: colors.foregroundMuted, fontSize: 12 }}>{props.label}</Text>
      <Text selectable style={{ flex: 1, color: colors.foreground, fontSize: 12 }}>
        {props.value}
      </Text>
    </View>
  );
}

function TurnRow(props: { theme: PluginTheme; turn: Turn }) {
  const { colors } = props.theme;
  const { turn } = props;
  const [open, setOpen] = useState(false);
  const mark = OUTCOME_MARKS[turn.outcome] ?? null;
  const missingInput =
    turn.userInput === null
      ? turn.contextIncomplete
        ? "未采集到该轮输入"
        : "本轮没有新的用户消息"
      : null;
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 8,
        backgroundColor: colors.surface1,
      }}
    >
      <Pressable
        accessibilityRole="button"
        onPress={function toggle() {
          setOpen(!open);
        }}
        style={{ padding: 10, flexDirection: "row", alignItems: "center", gap: 8 }}
      >
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
          {formatStepTime(turn.completedAt, Date.now())}
        </Text>
        <Text style={{ flex: 1, color: colors.foreground, fontSize: 12 }} numberOfLines={1}>
          {firstLine(turn.userInput, 300) ?? missingInput ?? "未采集到该轮输入"}
        </Text>
        {mark ? (
          <Text
            style={{
              color: turn.outcome === "failed" ? colors.statusDanger : colors.foregroundMuted,
              fontSize: 12,
            }}
          >
            {mark}
          </Text>
        ) : null}
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{open ? "收起" : "展开"}</Text>
      </Pressable>
      {open ? (
        <View style={{ padding: 10, paddingTop: 0, gap: 8 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
            {`${formatDateTime(turn.completedAt)}${turn.contextIncomplete ? " · 上下文不完整" : ""}`}
          </Text>
          <View style={{ gap: 3 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>用户输入</Text>
            {turn.userInput === null ? (
              <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{missingInput}</Text>
            ) : (
              <Markdown theme={props.theme} text={turn.userInput} compact />
            )}
          </View>
          <View style={{ gap: 3 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Agent 回复</Text>
            <Markdown theme={props.theme} text={turn.agentOutput} compact />
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** Detail actions rendered as header icon buttons; archive keeps its two-step confirm. */
export function useDetailActions(props: {
  session: SessionDetail;
  navigation: PluginScreenProps["navigation"];
  onClose(): void;
}) {
  const { session, navigation, onClose } = props;
  const actions = useSessionActions();
  const paseo = usePaseo();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [busy, setBusy] = useState(false);

  const live = session.liveness === "live";
  const analysis = session.analysis;
  const canApplyTitle =
    analysis !== null &&
    analysis.title.trim() !== "" &&
    analysis.title.trim() !== (session.agentTitle ?? "").trim();

  async function archive(): Promise<void> {
    if (!confirmArchive) {
      setConfirmArchive(true);
      return;
    }
    setBusy(true);
    try {
      await paseo.agents.ref(session.id).archive();
      await queryClient.invalidateQueries({ queryKey: SNAPSHOT_QUERY_KEY });
      toast.show("会话已归档", { variant: "success" });
      onClose();
    } catch (error) {
      toast.error(`归档失败：${errorText(error)}`);
      setConfirmArchive(false);
    } finally {
      setBusy(false);
    }
  }

  async function forget(): Promise<void> {
    const ok = await actions.forget(session.id);
    if (ok) onClose();
  }

  return {
    live,
    openAgent: navigation
      ? function open() {
          navigation.openAgent({ agentId: session.id });
          onClose();
        }
      : null,
    reanalyze: function reanalyze() {
      void actions.reanalyze(session.id);
    },
    reanalyzeDisabled: session.analysisState === "queued" || session.analysisState === "running",
    applyGeneratedTitle: canApplyTitle
      ? function apply() {
          void actions.applyGeneratedTitle(session.id);
        }
      : null,
    archiveSession: live ? archive : null,
    archiveConfirming: confirmArchive,
    archiveBusy: busy,
    forgetSession: live
      ? null
      : function onForget() {
          void forget();
        },
  };
}


/** Older 之前 items stay behind a toggle so 现在 stays near the top. */
const HISTORY_VISIBLE = 4;
const NEXT_VISIBLE = 3;

function nowToneColor(theme: PluginTheme, tone: NowTone): string {
  const { colors } = theme;
  switch (tone) {
    case "working":
      return colors.accent;
    case "waiting":
      return colors.statusWarning;
    case "blocked":
      return colors.statusDanger;
    case "done":
      return colors.statusSuccess;
    case "idle":
      return colors.foregroundMuted;
  }
}

function FoldSection(props: {
  theme: PluginTheme;
  title: string;
  trailing?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const { colors } = props.theme;
  const [open, setOpen] = useState(props.defaultOpen === true);
  return (
    <View style={{ gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        onPress={function toggle() {
          setOpen(!open);
        }}
        style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={colors.foregroundMuted} />
        <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: 13, fontWeight: "600" }}>
          {props.title}
        </Text>
        {props.trailing}
      </Pressable>
      {open ? props.children : null}
    </View>
  );
}

function StepRow(props: { theme: PluginTheme; mark: string; text: string; time?: string | null }) {
  const { colors } = props.theme;
  return (
    <View style={{ flexDirection: "row", gap: 6 }}>
      <Text style={{ width: 12, color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{props.mark}</Text>
      <Text selectable style={{ flex: 1, color: colors.foreground, fontSize: 13, lineHeight: 19 }}>
        {props.text}
      </Text>
      {props.time ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: 11, lineHeight: 19 }}>{props.time}</Text>
      ) : null}
    </View>
  );
}

function HistoryBlock(props: { theme: PluginTheme; session: SessionDetail }) {
  const { theme, session } = props;
  const { colors } = theme;
  const [showAll, setShowAll] = useState(false);
  const history = session.history;
  if (history.length === 0) {
    // Analyses from before the history existed only have the long 已完成 list.
    const legacy = session.analysis?.completed ?? [];
    return (
      <Section theme={theme} title="之前">
        {legacy.length === 0 ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>暂无记录</Text>
        ) : (
          <View style={{ gap: 4 }}>
            {legacy.slice(-HISTORY_VISIBLE).map(function renderLegacy(item, index) {
              return <StepRow key={index} theme={theme} mark="✓" text={firstLine(item, 120) ?? item} />;
            })}
          </View>
        )}
      </Section>
    );
  }
  const hidden = showAll ? 0 : Math.max(0, history.length - HISTORY_VISIBLE);
  const now = Date.now();
  return (
    <Section
      theme={theme}
      title="之前"
      trailing={
        history.length > HISTORY_VISIBLE ? (
          <Pressable
            accessibilityRole="button"
            onPress={function toggle() {
              setShowAll(!showAll);
            }}
          >
            <Text style={{ color: colors.accent, fontSize: 12 }}>
              {showAll ? "收起" : `更早 ${hidden} 条`}
            </Text>
          </Pressable>
        ) : null
      }
    >
      <View style={{ gap: 4 }}>
        {history.slice(hidden).map(function renderEntry(entry, index, shown) {
          // One time label per turn: on the turn's first item.
          const previous = index > 0 ? shown[index - 1] : undefined;
          const time = previous?.turnId === entry.turnId ? null : formatStepTime(entry.at, now);
          return <StepRow key={`${entry.turnId}:${index}`} theme={theme} mark="✓" text={entry.text} time={time} />;
        })}
      </View>
    </Section>
  );
}

function NowBlock(props: {
  theme: PluginTheme;
  session: SessionDetail;
  live: LiveState | null;
  compact: boolean;
}) {
  const { theme, session } = props;
  const { colors } = theme;
  const actions = useSessionActions();
  const line = nowLine(session, props.live);
  const tone = nowToneColor(theme, line.tone);
  const live = session.liveness === "live";
  const dormant = session.liveness === "dormant";
  const reopenable = session.liveness === "closed" || session.liveness === "archived";
  const resuming = session.resumeState === "queued" || session.resumeState === "resuming";
  const reviewPhase = session.review?.phase ?? null;
  const reviewBusy =
    reviewPhase === "requested" || reviewPhase === "reviewing" || reviewPhase === "verifying";
  const [reviewOpen, setReviewOpen] = useState(false);
  return (
    <Section theme={theme} title="现在">
      <View
        style={{
          gap: 6,
          paddingVertical: 8,
          paddingHorizontal: 10,
          borderLeftWidth: 3,
          borderLeftColor: tone,
          borderRadius: 6,
          backgroundColor: colors.surface1,
        }}
      >
        <Text selectable style={{ color: colors.foreground, fontSize: 13, lineHeight: 19, fontWeight: "600" }}>
          {line.text}
        </Text>
        {line.detail ? (
          <Text selectable style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
            {line.detail}
          </Text>
        ) : null}
        {session.analysisError ? (
          <Text selectable style={{ color: colors.statusDanger, fontSize: 12, lineHeight: 18 }}>
            {`分析失败：${session.analysisError}`}
          </Text>
        ) : null}
        {(dormant || reopenable) && session.resumeError ? (
          <Text style={{ color: colors.statusDanger, fontSize: 12, lineHeight: 18 }}>{session.resumeError}</Text>
        ) : null}
        {reopenable ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <Chip
              theme={theme}
              label={resuming ? "重新打开中…" : session.resumeState === "failed" ? "重试" : "重新打开"}
              selected={false}
              disabled={resuming}
              onPress={function reopen() {
                void actions.reopen(session.id);
              }}
            />
          </View>
        ) : null}
        {dormant ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <Chip
              theme={theme}
              label={resuming ? "恢复中…" : session.resumeState === "failed" ? "重试" : "恢复"}
              selected={false}
              disabled={resuming}
              onPress={function resume() {
                void actions.resume(session.id);
              }}
            />
            <Chip
              theme={theme}
              label="不再恢复"
              selected={false}
              disabled={resuming}
              onPress={function dismiss() {
                void actions.dismissResume(session.id);
              }}
            />
          </View>
        ) : null}
        {live ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <Chip
              theme={theme}
              label="代码审查"
              selected={false}
              disabled={reviewBusy}
              onPress={function openReview() {
                setReviewOpen(true);
              }}
            />
            {reviewPhase === "suggested" ? (
              <Chip
                theme={theme}
                label="忽略建议"
                selected={false}
                onPress={function dismissReview() {
                  void actions.dismissReview(session.id);
                }}
              />
            ) : null}
          </View>
        ) : null}
        {live ? (
          <ReviewRequestDialog
            sessionId={session.id}
            open={reviewOpen}
            onOpenChange={setReviewOpen}
            theme={theme}
            compact={props.compact}
          />
        ) : null}
      </View>
    </Section>
  );
}

function NextBlock(props: {
  theme: PluginTheme;
  session: SessionDetail;
  live: LiveState | null;
  pendingTodos: readonly string[];
}) {
  const { theme, session, live } = props;
  const { colors } = theme;
  const running = live ? live.running : session.lifecycle === "working";
  // While running, the agent's own todo list is the live plan; the analysis
  // only knows the last finished turn.
  const steps = running ? props.pendingTodos : (session.analysis?.nextSteps ?? []);
  const empty = running ? "运行结束后更新" : "暂无";
  return (
    <Section theme={theme} title="下一步">
      {steps.length === 0 ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{empty}</Text>
      ) : (
        <View style={{ gap: 4 }}>
          {steps.slice(0, NEXT_VISIBLE).map(function renderStep(step, index) {
            return <StepRow key={index} theme={theme} mark="→" text={firstLine(step, 120) ?? step} />;
          })}
        </View>
      )}
    </Section>
  );
}

function StatusControls(props: { theme: PluginTheme; session: SessionDetail }) {
  const { theme, session } = props;
  const { colors } = theme;
  const actions = useSessionActions();
  const [picking, setPicking] = useState(false);
  const active = isActiveLiveness(session.liveness);
  if (!active) {
    return null;
  }
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <Chip
          theme={theme}
          label="改状态"
          selected={picking}
          onPress={function toggle() {
            setPicking(!picking);
          }}
        />
        {session.manualStatusOverride ? (
          <Badge theme={theme} label="手工覆盖" tone={colors.foregroundMuted} />
        ) : null}
        {session.deferEndedAt !== null ? <Badge theme={theme} label="延迟已结束" tone={colors.accent} /> : null}
      </View>
      {session.deferredUntil !== null ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
          {`延迟至 ${formatDeferUntil(session.deferredUntil, Date.now())} · ${formatDeferRemaining(session.deferredUntil, Date.now())}${session.deferToQueue ? " · 延迟队列" : " · 留原列"}`}
        </Text>
      ) : null}
      {picking ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {STATUS_OPTIONS.map(function renderOption(option) {
            return (
              <Chip
                key={option.status}
                theme={theme}
                label={option.label}
                tone={statusTone(theme, option.status)}
                selected={session.effectiveStatus === option.status}
                onPress={function select() {
                  void actions.setManualStatus(session.id, option.status);
                }}
              />
            );
          })}
          {session.manualStatusOverride ? (
            <Chip
              theme={theme}
              label="恢复自动状态"
              selected={false}
              onPress={function restore() {
                void actions.clearManualStatus(session.id);
              }}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Sub-agent statuses worth marking; "completed" is the quiet default. */
const SUB_AGENT_STATUS_MARKS: Record<string, string> = {
  running: "进行中",
  failed: "失败",
  canceled: "已取消",
};

/** One row of the flow section's per-turn list; expands to digest + sub-agents. */
function FlowTurnRow(props: {
  theme: PluginTheme;
  turn: FlowTurn;
  open: boolean;
  onToggle(): void;
}) {
  const { theme, turn, open } = props;
  const { colors } = theme;
  const mark = OUTCOME_MARKS[turn.outcome as Turn["outcome"]] ?? null;
  // Same fallback chain as the chart node: step → 该轮「之前」首条 → 用户输入.
  const title = turn.step || turn.historyLabel || firstLine(turn.userInput, 40) || "未命名步骤";
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 8,
        backgroundColor: colors.surface1,
      }}
    >
      <Pressable
        accessibilityRole="button"
        onPress={props.onToggle}
        style={{ padding: 10, flexDirection: "row", alignItems: "center", gap: 8 }}
      >
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
          {`第 ${turn.index} 轮 · ${formatStepTime(turn.completedAt, Date.now())}`}
        </Text>
        <Text style={{ flex: 1, color: colors.foreground, fontSize: 12 }} numberOfLines={1}>
          {title}
        </Text>
        {mark ? (
          <Text
            style={{
              color: turn.outcome === "failed" ? colors.statusDanger : colors.foregroundMuted,
              fontSize: 12,
            }}
          >
            {mark}
          </Text>
        ) : null}
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{open ? "收起" : "展开"}</Text>
      </Pressable>
      {open ? (
        <View style={{ padding: 10, paddingTop: 0, gap: 8 }}>
          <View style={{ gap: 3 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>摘要</Text>
            {turn.digest ? (
              <Text selectable style={{ color: colors.foreground, fontSize: 12, lineHeight: 18 }}>
                {turn.digest}
              </Text>
            ) : (
              <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>暂无摘要</Text>
            )}
          </View>
          {turn.userInput ? (
            <View style={{ gap: 3 }}>
              <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>用户输入</Text>
              <Text selectable style={{ color: colors.foreground, fontSize: 12, lineHeight: 18 }}>
                {turn.userInput}
              </Text>
            </View>
          ) : null}
          {turn.subAgents.length + turn.children.length > 0 ? (
            <View style={{ gap: 3 }}>
              <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>子 Agent</Text>
              {turn.subAgents.map(function renderSubAgent(subAgent) {
                const status = SUB_AGENT_STATUS_MARKS[subAgent.status] ?? null;
                return (
                  <View key={subAgent.callId} style={{ gap: 1 }}>
                    <Text style={{ color: colors.foreground, fontSize: 12 }}>
                      {`子 Agent · ${subAgent.type || "未命名"}${status ? `（${status}）` : ""}`}
                    </Text>
                    {subAgent.description !== "" ? (
                      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
                        {subAgent.description}
                      </Text>
                    ) : null}
                  </View>
                );
              })}
              {turn.children.map(function renderChild(child) {
                return (
                  <View key={child.id} style={{ gap: 1 }}>
                    <Text style={{ color: colors.foreground, fontSize: 12 }}>
                      {`子会话 · ${child.columnLabel}`}
                    </Text>
                    {child.detail ? (
                      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
                        {child.detail}
                      </Text>
                    ) : null}
                  </View>
                );
              })}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Fetches the flow lazily — the enclosing FoldSection mounts this on expand. */
function FlowBody(props: { theme: PluginTheme; session: SessionDetail }) {
  const { theme, session } = props;
  const { colors } = theme;
  const flowGet = useRpc(flowGetRpc);
  // Expanded rows are keyed by turnId up here so a data refresh never folds them.
  const [openTurns, setOpenTurns] = useState<Record<string, boolean>>({});
  const query = useQuery({
    queryKey: ["session-manager", "flow", session.id, session.updatedAt],
    queryFn: async function load() {
      return flowGet({ id: session.id });
    },
    staleTime: Infinity,
    retry: false,
    // A new turn changes updatedAt and refetches; keep the last chart on
    // screen instead of flashing the loading line between keys.
    placeholderData: function keepPrevious(previous) {
      return previous;
    },
  });
  if (query.isPending) {
    return <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>正在生成流程图…</Text>;
  }
  if (query.isError) {
    return (
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
        {`流程图加载失败：${errorText(query.error)}`}
      </Text>
    );
  }
  const data = query.data;
  if (data === undefined || !data.ok) {
    return (
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
        {`流程图不可用：${data !== undefined && !data.ok ? data.error : "未知错误"}`}
      </Text>
    );
  }
  if (data.turns.length === 0) {
    return <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>还没有可画的轮次</Text>;
  }
  return (
    <View style={{ gap: 8 }}>
      <MermaidBlock theme={theme} code={data.code} />
      <View style={{ gap: 4 }}>
        {data.turns.map(function renderFlowTurn(turn) {
          return (
            <FlowTurnRow
              key={turn.turnId}
              theme={theme}
              turn={turn}
              open={openTurns[turn.turnId] === true}
              onToggle={function toggle() {
                setOpenTurns(function update(current) {
                  return { ...current, [turn.turnId]: current[turn.turnId] !== true };
                });
              }}
            />
          );
        })}
      </View>
    </View>
  );
}

/** Newest analysis records shown before 显示更早 is pressed. */
const RUNS_VISIBLE = 10;

/** One analyzer call: when it ran and what the user said in the analyzed turn. */
function AnalysisRunRow(props: { theme: PluginTheme; run: AnalysisRunSummary; onOpen(): void }) {
  const { theme, run } = props;
  const { colors } = theme;
  const mark =
    run.outcome === "failed"
      ? "失败"
      : run.outcome !== "applied"
        ? "未采用"
        : run.confidence !== null
          ? confidenceLabel(run.confidence)
          : null;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onOpen}
      style={{
        padding: 10,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 8,
        backgroundColor: colors.surface1,
      }}
    >
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
        {formatStepTime(run.startedAt, Date.now())}
      </Text>
      <Text style={{ flex: 1, color: colors.foreground, fontSize: 12 }} numberOfLines={1}>
        {firstLine(run.userInput, 300) ?? "无新的用户消息"}
      </Text>
      {run.reanalysis ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>重新分析</Text>
      ) : null}
      {mark ? (
        <Text
          style={{
            color: run.outcome === "failed" ? colors.statusDanger : colors.foregroundMuted,
            fontSize: 12,
          }}
        >
          {mark}
        </Text>
      ) : null}
      <Icon name="ChevronRight" size={14} color={colors.foregroundMuted} />
    </Pressable>
  );
}

/** Every analyzer call of the session, newest first; a row opens its details in a dialog. */
function AnalysisRuns(props: { theme: PluginTheme; session: SessionDetail }) {
  const { theme, session } = props;
  const { colors } = theme;
  const [target, setTarget] = useState<AnalysisRunTarget | null>(null);
  const [showAll, setShowAll] = useState(false);
  const runs = session.analysisRuns;
  const note = latestRunNote(runs, session.analysis);
  const pending = session.analysisState === "queued" || session.analysisState === "running";
  const shown = showAll ? runs : runs.slice(0, RUNS_VISIBLE);
  const legacy = runs.length === 0 ? session.analysis : null;
  return (
    <FoldSection
      theme={theme}
      title={`分析记录（${runs.length}）`}
      trailing={
        note ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{note}</Text> : null
      }
    >
      {session.declared ? (
        <View style={{ gap: 3 }}>
          <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "600" }}>Agent 结论</Text>
          <Text
            selectable
            style={{ color: declaredTone(theme, session.declared.kind), fontSize: 12, lineHeight: 18 }}
          >
            {`${DECLARED_KIND_LABELS[session.declared.kind]}：${session.declared.text}`}
          </Text>
        </View>
      ) : null}
      {pending ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
          {`${analysisStateLabel(session.analysisState)}…`}
        </Text>
      ) : null}
      {runs.length > 0 ? (
        <View style={{ gap: 4 }}>
          {shown.map(function renderRun(run) {
            return (
              <AnalysisRunRow
                key={run.id}
                theme={theme}
                run={run}
                onOpen={function open() {
                  setTarget({ kind: "run", run });
                }}
              />
            );
          })}
          {runs.length > RUNS_VISIBLE ? (
            <Pressable
              accessibilityRole="button"
              onPress={function toggle() {
                setShowAll(!showAll);
              }}
            >
              <Text style={{ color: colors.accent, fontSize: 12 }}>
                {showAll ? "收起" : `显示更早的 ${runs.length - RUNS_VISIBLE} 条`}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : legacy ? (
        <Pressable
          accessibilityRole="button"
          onPress={function open() {
            setTarget({ kind: "legacy", analysis: legacy });
          }}
          style={{
            padding: 10,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: 8,
            backgroundColor: colors.surface1,
          }}
        >
          <Text style={{ flex: 1, color: colors.foreground, fontSize: 12 }} numberOfLines={1}>
            早前的分析（未记录调用信息）
          </Text>
          <Icon name="ChevronRight" size={14} color={colors.foregroundMuted} />
        </Pressable>
      ) : pending ? null : (
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
          {`${analysisStateLabel(session.analysisState)}，暂无分析记录。`}
        </Text>
      )}
      <AnalysisRunDialog
        sessionId={session.id}
        target={target}
        theme={theme}
        onClose={function close() {
          setTarget(null);
        }}
      />
    </FoldSection>
  );
}

export function DetailContent(props: {
  session: SessionDetail;
  theme: PluginTheme;
  /** Live state from the open conversation; null until it has loaded. */
  live?: LiveState | null;
  pendingTodos?: readonly string[];
  compact?: boolean;
}) {
  const { session, theme } = props;
  const { colors } = theme;
  const live = props.live ?? null;
  const compact = props.compact === true;
  const turns = [...session.turns].reverse();

  const metadata: [string, string][] = [
    ["Agent/模型", `${session.provider}${session.model ? ` / ${session.model}` : ""}`],
    ["项目", session.projectName ?? "未知项目"],
    ["工作区", workspaceLabel(session)],
    ["分支", branchLabel(session) ?? "未知"],
    ["会话标识", session.id],
    ["最近更新", formatDateTime(session.updatedAt)],
    ["连接", `${livenessLabel(session.liveness)} · ${lifecycleLabel(session.lifecycle)}`],
    ["分析状态", analysisStateLabel(session.analysisState)],
    [
      "标题归属",
      session.titleState.userOwned ? "标题由你管理" : session.titleState.lastWritten ? "由看板生成" : "Paseo 自动标题",
    ],
  ];

  return (
    <>
      <StatusControls theme={theme} session={session} />
      <HistoryBlock theme={theme} session={session} />
      <NowBlock theme={theme} session={session} live={live} compact={compact} />
      <NextBlock theme={theme} session={session} live={live} pendingTodos={props.pendingTodos ?? []} />

      <View style={{ height: 1, backgroundColor: colors.border }} />

      <FoldSection theme={theme} title="流程图" defaultOpen>
        <FlowBody theme={theme} session={session} />
      </FoldSection>

      <AnalysisRuns theme={theme} session={session} />

      <FoldSection theme={theme} title="会话信息">
        <View style={{ gap: 4 }}>
          {metadata.map(function renderField(entry) {
            return <Field key={entry[0]} theme={theme} label={entry[0]} value={entry[1]} />;
          })}
        </View>
      </FoldSection>

      <FoldSection theme={theme} title={`会话记录（${session.turns.length}）`} defaultOpen>
        {turns.length === 0 ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>看板尚未保存会话内容。</Text>
        ) : (
          <View style={{ gap: 8 }}>
            {turns.map(function renderTurn(turn) {
              return <TurnRow key={turn.id} theme={theme} turn={turn} />;
            })}
          </View>
        )}
      </FoldSection>
    </>
  );
}
