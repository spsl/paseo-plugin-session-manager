import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import {
  analysisStateLabel,
  analysisStatusLabel,
  branchLabel,
  columnForStatus,
  formatDeferRemaining,
  formatDeferUntil,
  lifecycleLabel,
  livenessLabel,
  RESTART_INTERRUPTED_TEXT,
  resumeStateLabel,
  STATUS_OPTIONS,
  workspaceLabel,
} from "../shared/presentation";
import { isActiveLiveness, type SessionDetail, type Turn } from "../shared/types";
import { Badge, Chip } from "./badge";
import { columnTone, errorText, formatDateTime, statusTone } from "./styles";
import { SNAPSHOT_QUERY_KEY, useSessionActions } from "./use-snapshot";

const OUTCOME_LABELS: Record<Turn["outcome"], string> = {
  completed: "已完成",
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
  const mono = { fontFamily: "monospace" as const, fontSize: 12, lineHeight: 18, color: colors.foreground };
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
        <Text style={{ flex: 1, color: colors.foreground, fontSize: 12 }} numberOfLines={1}>
          {`${formatDateTime(turn.completedAt)} · ${OUTCOME_LABELS[turn.outcome]}${turn.contextIncomplete ? " · 上下文不完整" : ""}`}
        </Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{open ? "收起" : "展开"}</Text>
      </Pressable>
      {open ? (
        <View style={{ padding: 10, paddingTop: 0, gap: 8 }}>
          <View style={{ gap: 3 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>用户输入</Text>
            <Text selectable style={mono}>
              {turn.userInput ?? "未采集到该轮输入"}
            </Text>
          </View>
          <View style={{ gap: 3 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Agent 回复</Text>
            <Text selectable style={mono}>
              {turn.agentOutput}
            </Text>
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

export function DetailContent(props: {
  session: SessionDetail;
  theme: PluginTheme;
  onDefer?(): void;
}) {
  const { session, theme } = props;
  const { colors } = theme;
  const actions = useSessionActions();
  const [showTurns, setShowTurns] = useState(false);

  const active = isActiveLiveness(session.liveness);
  const dormant = session.liveness === "dormant";
  const analysis = session.analysis;
  const turns = [...session.turns].reverse();
  const resuming = session.resumeState === "queued" || session.resumeState === "resuming";

  const statusColumn = columnForStatus(session.effectiveStatus);
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
      <Section theme={theme} title="看板状态">
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          <Badge
            theme={theme}
            label={active ? analysisStatusLabel(session.effectiveStatus) : "已关闭"}
            tone={active ? statusTone(theme, session.effectiveStatus) : columnTone(theme, "closed")}
          />
          {session.deferEndedAt !== null ? (
            <Badge theme={theme} label="延迟已结束" tone={colors.accent} />
          ) : null}
          {dormant ? (
            <Badge
              theme={theme}
              label={resumeStateLabel(session) ?? "未连接"}
              tone={session.resumeState === "failed" ? colors.statusDanger : colors.foregroundMuted}
            />
          ) : null}
          {session.manualStatusOverride ? (
            <Badge theme={theme} label="手工覆盖" tone={colors.foregroundMuted} />
          ) : null}
        </View>
        {dormant ? (
          <View style={{ gap: 8 }}>
            {session.interruptedAt !== null ? (
              <Text style={{ color: colors.statusWarning, fontSize: 12, lineHeight: 18 }}>
                {RESTART_INTERRUPTED_TEXT}
              </Text>
            ) : (
              <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
                Paseo 重启后此会话未连接，可恢复后继续。
              </Text>
            )}
            {session.resumeError ? (
              <Text style={{ color: colors.statusDanger, fontSize: 12, lineHeight: 18 }}>
                {session.resumeError}
              </Text>
            ) : null}
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
          </View>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {STATUS_OPTIONS.map(function renderOption(option) {
            return (
              <Chip
                key={option.status}
                theme={theme}
                label={option.label}
                tone={statusTone(theme, option.status)}
                selected={active && session.effectiveStatus === option.status}
                disabled={!active}
                onPress={function select() {
                  void actions.setManualStatus(session.id, option.status);
                }}
              />
            );
          })}
          {active && session.manualStatusOverride ? (
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
        {active && props.onDefer ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
            {session.deferredUntil !== null ? (
              <>
                <Badge
                  theme={theme}
                  label={`延迟至 ${formatDeferUntil(session.deferredUntil, Date.now())} · ${formatDeferRemaining(session.deferredUntil, Date.now())}${session.deferToQueue ? " · 延迟队列" : " · 留原列"}`}
                  tone={colors.foregroundMuted}
                />
                <Chip
                  theme={theme}
                  label="立即恢复"
                  selected={false}
                  onPress={function resume() {
                    void actions.clearDefer(session.id);
                  }}
                />
                <Chip theme={theme} label="重新设置" selected={false} onPress={props.onDefer} />
              </>
            ) : (
              <Chip theme={theme} label="延迟显示…" selected={false} onPress={props.onDefer} />
            )}
          </View>
        ) : null}
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
          {active
            ? session.manualStatusOverride
              ? "手工状态会覆盖当前分析，直到恢复自动状态。"
              : `当前归入「${statusColumn === "waiting_for_user" ? "需要处理" : analysisStatusLabel(session.effectiveStatus)}」列。`
            : "会话已关闭，状态保持为历史记录。"}
        </Text>
      </Section>

      <Section theme={theme} title="会话信息">
        <View style={{ gap: 4 }}>
          {metadata.map(function renderField(entry) {
            return <Field key={entry[0]} theme={theme} label={entry[0]} value={entry[1]} />;
          })}
        </View>
      </Section>

      <Section
        theme={theme}
        title="分析"
        trailing={
          analysis ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
              {`置信度 ${Math.round(analysis.confidence * 100)}%`}
            </Text>
          ) : null
        }
      >
        {session.analysisError ? (
          <Text style={{ color: colors.statusDanger, fontSize: 12, lineHeight: 18 }}>
            {session.analysisError}
          </Text>
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
            <ListBlock theme={theme} title="下一步" items={analysis.nextSteps} empty="暂无下一步建议" />
            <ListBlock theme={theme} title="阻塞原因" items={analysis.blockers} empty="未发现阻塞项" />
          </View>
        ) : session.analysisError ? null : (
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
            {analysisStateLabel(session.analysisState)}，暂无分析结论。
          </Text>
        )}
      </Section>

      <Section
        theme={theme}
        title={`会话记录（${session.turns.length}）`}
        trailing={
          <Pressable
            accessibilityRole="button"
            onPress={function toggle() {
              setShowTurns(!showTurns);
            }}
          >
            <Text style={{ color: colors.accent, fontSize: 12 }}>{showTurns ? "收起" : "展开"}</Text>
          </Pressable>
        }
      >
        {showTurns ? (
          turns.length === 0 ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>看板尚未保存会话内容。</Text>
          ) : (
            <View style={{ gap: 8 }}>
              {turns.map(function renderTurn(turn) {
                return <TurnRow key={turn.id} theme={theme} turn={turn} />;
              })}
            </View>
          )
        ) : null}
      </Section>
    </>
  );
}
