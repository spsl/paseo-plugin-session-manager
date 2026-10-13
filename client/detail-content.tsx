import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import {
  analysisStateLabel,
  branchLabel,
  firstLine,
  formatDeferRemaining,
  formatDeferUntil,
  formatStepTime,
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
  type SessionDetail,
  type Turn,
} from "../shared/types";
import { Badge, Chip } from "./badge";
import { withoutSteerPrefix } from "./conversation/model";
import { Markdown } from "./markdown/markdown";
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

function ListBlock(props: { theme: PluginTheme; title: string; items: readonly string[]; empty: string }) {
  const { colors } = props.theme;
  return (
    <View style={{ gap: 3 }}>
      <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "600" }}>{props.title}</Text>
      {props.items.length === 0 ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{props.empty}</Text>
      ) : (
        props.items.map(function renderItem(item, index) {
          return (
            <Text key={index} style={{ color: colors.foreground, fontSize: 12, lineHeight: 18 }}>
              {`• ${item}`}
            </Text>
          );
        })
      )}
    </View>
  );
}

function TurnRow(props: { theme: PluginTheme; turn: Turn }) {
  const { colors } = props.theme;
  const { turn } = props;
  const [open, setOpen] = useState(false);
  const mark = OUTCOME_MARKS[turn.outcome] ?? null;
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
          {firstLine(turn.userInput === null ? null : withoutSteerPrefix(turn.userInput), 300) ??
            "未采集到该轮输入"}
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
              <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>未采集到该轮输入</Text>
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

function NowBlock(props: { theme: PluginTheme; session: SessionDetail; live: LiveState | null }) {
  const { theme, session } = props;
  const { colors } = theme;
  const actions = useSessionActions();
  const line = nowLine(session, props.live);
  const tone = nowToneColor(theme, line.tone);
  const dormant = session.liveness === "dormant";
  const resuming = session.resumeState === "queued" || session.resumeState === "resuming";
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
        {dormant && session.resumeError ? (
          <Text style={{ color: colors.statusDanger, fontSize: 12, lineHeight: 18 }}>{session.resumeError}</Text>
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

function AnalysisDetails(props: { theme: PluginTheme; session: SessionDetail }) {
  const { theme, session } = props;
  const { colors } = theme;
  const analysis = session.analysis;
  return (
    <FoldSection
      theme={theme}
      title="详细分析"
      trailing={
        analysis ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
            {`置信度 ${Math.round(analysis.confidence * 100)}%`}
          </Text>
        ) : null
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
      {analysis ? (
        <View style={{ gap: 10 }}>
          <View style={{ gap: 3 }}>
            <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "600" }}>当前判断</Text>
            <Text selectable style={{ color: colors.foreground, fontSize: 12, lineHeight: 18 }}>
              {analysis.summary || "暂无"}
            </Text>
          </View>
          <View style={{ gap: 3 }}>
            <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "600" }}>当前目标</Text>
            <Text selectable style={{ color: colors.foreground, fontSize: 12, lineHeight: 18 }}>
              {analysis.goal || "暂无"}
            </Text>
          </View>
          <ListBlock theme={theme} title="进展" items={analysis.progress} empty="暂无明确进展" />
          <ListBlock theme={theme} title="已完成" items={analysis.completed} empty="尚无完成证据" />
          <ListBlock theme={theme} title="阻塞原因" items={analysis.blockers} empty="未发现阻塞项" />
        </View>
      ) : (
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
          {`${analysisStateLabel(session.analysisState)}，暂无分析结论。`}
        </Text>
      )}
    </FoldSection>
  );
}

export function DetailContent(props: {
  session: SessionDetail;
  theme: PluginTheme;
  /** Live state from the open conversation; null until it has loaded. */
  live?: LiveState | null;
  pendingTodos?: readonly string[];
}) {
  const { session, theme } = props;
  const { colors } = theme;
  const live = props.live ?? null;
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
      <NowBlock theme={theme} session={session} live={live} />
      <NextBlock theme={theme} session={session} live={live} pendingTodos={props.pendingTodos ?? []} />

      <View style={{ height: 1, backgroundColor: colors.border }} />

      <AnalysisDetails theme={theme} session={session} />

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
