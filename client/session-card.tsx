import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { memo } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import {
  analysisStateLabel,
  branchLabel,
  firstLine,
  formatDeferRemaining,
  formatDeferUntil,
  formatShortTimeAgo,
  resumeStateLabel,
  sessionTitle,
  workspaceLabel,
} from "../shared/presentation";
import { isActiveLiveness, type SessionView } from "../shared/types";
import { Badge } from "./badge";
import { countSubagents, EMPTY_SUBAGENTS, isDeferred, subagentStatusOf } from "./board-model";
import { columnTone, toneBackground, withAlpha } from "./styles";

type Props = {
  session: SessionView;
  theme: PluginTheme;
  now: number;
  /** Embedded sub-agents; the collapsible section renders when non-empty. */
  subagents?: readonly SessionView[];
  subagentsExpanded?: boolean;
  onToggleSubagents?(parentId: string): void;
  /** Embedded sub-agent row to highlight (a deep-link hit); null elsewhere. */
  highlightSubagentId?: string | null;
  /** Standalone sub-agent's missing/closed/filtered parent, for the "父：" link. */
  detachedParent?: SessionView | null;
  onOpen?(session: SessionView): void;
  /** Opens the defer menu; only rendered when the session is not deferred. */
  onDefer?(session: SessionView): void;
  /** Resumes a deferred session immediately. */
  onResume?(session: SessionView): void;
};

function SessionCardView(props: Props) {
  const { session, theme, now } = props;
  const { colors } = theme;
  const branch = branchLabel(session);
  const nextStep = firstLine(session.analysis?.nextSteps[0], 120);
  const summary = firstLine(session.analysis?.summary, 160);
  const working = session.liveness === "live" && session.lifecycle === "working";
  const running = session.analysisState === "running" || session.analysisState === "queued";
  const attention =
    session.analysis?.needsUserAttention === true && isActiveLiveness(session.liveness);
  const deferred = isDeferred(session, now);
  const resume = resumeStateLabel(session);
  const resuming = session.resumeState === "queued" || session.resumeState === "resuming";
  const subagents = props.subagents ?? EMPTY_SUBAGENTS;
  const counts = subagents.length > 0 ? countSubagents(subagents, now) : null;
  const expanded = props.subagentsExpanded === true;
  const detachedParent = props.detachedParent ?? null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={sessionTitle(session)}
      onPress={function open() {
        props.onOpen?.(session);
      }}
      style={{
        gap: 6,
        padding: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingRight: props.onDefer || props.onResume ? 22 : 0,
        }}
      >
        <Text
          numberOfLines={1}
          style={{ flex: 1, color: colors.foreground, fontSize: 13, fontWeight: "600" }}
        >
          {sessionTitle(session)}
        </Text>
        {working || running || resuming ? (
          <ActivityIndicator size="small" color={colors.accent} />
        ) : null}
      </View>
      <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11 }}>
        {`工作区：${workspaceLabel(session)}${branch ? `  ·  分支：${branch}` : ""}`}
      </Text>
      <Text
        numberOfLines={2}
        style={{
          color: summary ? colors.foreground : colors.foregroundMuted,
          fontSize: 12,
          lineHeight: 17,
        }}
      >
        {summary ?? analysisStateLabel(session.analysisState)}
      </Text>
      {nextStep ? (
        <Text numberOfLines={2} style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
          {`下一步：${nextStep}`}
        </Text>
      ) : null}
      {detachedParent ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`打开父会话：${sessionTitle(detachedParent)}`}
          hitSlop={4}
          onPress={function openParent() {
            props.onOpen?.(detachedParent);
          }}
          style={{ alignSelf: "flex-start" }}
        >
          <Text numberOfLines={1} style={{ color: colors.accent, fontSize: 11 }}>
            {`父：${sessionTitle(detachedParent)}`}
          </Text>
        </Pressable>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
        {session.deferEndedAt !== null ? (
          <Badge theme={theme} label="延迟已结束" tone={colors.accent} />
        ) : null}
        {resume !== null ? (
          <Badge
            theme={theme}
            label={resume}
            tone={session.resumeState === "failed" ? colors.statusDanger : colors.foregroundMuted}
          />
        ) : null}
        {session.interruptedAt !== null ? (
          <Badge theme={theme} label="重启时任务被中断" tone={colors.statusWarning} />
        ) : null}
        {session.manualStatusOverride ? (
          <Badge theme={theme} label="手工覆盖" tone={colors.foregroundMuted} />
        ) : null}
        {session.effectiveStatus === "blocked" ? (
          <Badge theme={theme} label="阻塞" tone={colors.statusDanger} />
        ) : null}
        {attention ? <Badge theme={theme} label="需要人工介入" tone={colors.statusWarning} /> : null}
        {session.pendingPermissionCount > 0 ? (
          <Badge theme={theme} label="待授权" tone={colors.statusWarning} />
        ) : null}
        {session.parentAgentId ? (
          <Badge theme={theme} label="子 Agent" tone={colors.foregroundMuted} />
        ) : null}
        {counts !== null && counts.attention > 0 ? (
          <Badge theme={theme} label="子任务需处理" tone={colors.statusWarning} />
        ) : null}
        <View style={{ flex: 1 }} />
        <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
          {formatShortTimeAgo(session.updatedAt, now)}
        </Text>
      </View>
      {counts !== null ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: colors.border,
            paddingTop: 6,
            gap: 2,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expanded ? "收起子 Agent" : `展开 ${counts.total} 个子 Agent`}
            hitSlop={4}
            onPress={function toggle() {
              props.onToggleSubagents?.(session.id);
            }}
            style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
          >
            <Icon
              name={expanded ? "ChevronDown" : "ChevronRight"}
              size={13}
              color={colors.foregroundMuted}
            />
            <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
              {`子 Agent ${counts.total}`}
            </Text>
            <View style={{ flex: 1 }} />
            {counts.attention > 0 ? (
              <Badge
                theme={theme}
                label={`需处理 ${counts.attention}`}
                tone={columnTone(theme, "waiting_for_user")}
              />
            ) : null}
            {counts.inProgress > 0 ? (
              <Badge
                theme={theme}
                label={`进行中 ${counts.inProgress}`}
                tone={columnTone(theme, "in_progress")}
              />
            ) : null}
            {counts.completed > 0 ? (
              <Badge
                theme={theme}
                label={`已完成 ${counts.completed}`}
                tone={columnTone(theme, "completed")}
              />
            ) : null}
            {counts.unclear > 0 ? (
              <Badge
                theme={theme}
                label={`未明确 ${counts.unclear}`}
                tone={columnTone(theme, "unclear")}
              />
            ) : null}
            {counts.deferred > 0 ? (
              <Badge
                theme={theme}
                label={`已延迟 ${counts.deferred}`}
                tone={columnTone(theme, "deferred")}
              />
            ) : null}
            {counts.closed > 0 ? (
              <Badge
                theme={theme}
                label={`已关闭 ${counts.closed}`}
                tone={columnTone(theme, "closed")}
              />
            ) : null}
          </Pressable>
          {expanded
            ? subagents.map(function renderSubagent(child) {
                const status = subagentStatusOf(child, now);
                const tone = columnTone(theme, status.column);
                const highlighted = props.highlightSubagentId === child.id;
                return (
                  <Pressable
                    key={child.id}
                    accessibilityRole="button"
                    accessibilityLabel={`子 Agent：${sessionTitle(child)}`}
                    onPress={function open() {
                      props.onOpen?.(child);
                    }}
                    style={function rowStyle({ pressed }) {
                      return {
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 6,
                        paddingVertical: 3,
                        paddingHorizontal: 4,
                        marginHorizontal: -4,
                        borderRadius: 5,
                        backgroundColor: highlighted
                          ? toneBackground(theme, colors.accent)
                          : pressed
                            ? colors.surface2
                            : "transparent",
                      };
                    }}
                  >
                    <View
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: tone,
                      }}
                    />
                    <Text style={{ color: tone, fontSize: 11 }}>{status.label}</Text>
                    <Text
                      numberOfLines={1}
                      style={{ flex: 1, color: colors.foreground, fontSize: 12 }}
                    >
                      {sessionTitle(child)}
                    </Text>
                    <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>
                      {formatShortTimeAgo(child.updatedAt, now)}
                    </Text>
                  </Pressable>
                );
              })
            : null}
        </View>
      ) : null}
      {deferred && session.deferredUntil !== null ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            borderRadius: 8,
            backgroundColor: withAlpha(colors.surface0, "D9", colors.surface0),
            alignItems: "center",
            justifyContent: "center",
            gap: 3,
          }}
        >
          <Icon name="Timer" size={15} color={colors.foregroundMuted} />
          <Text style={{ color: colors.foreground, fontSize: 11, fontWeight: "600" }}>
            {`延迟至 ${formatDeferUntil(session.deferredUntil, now)}`}
          </Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>
            {formatDeferRemaining(session.deferredUntil, now)}
          </Text>
        </View>
      ) : null}
      {deferred && props.onResume ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="立即恢复显示"
          hitSlop={6}
          onPress={function resume() {
            props.onResume?.(session);
          }}
          style={{ position: "absolute", top: 6, right: 6, zIndex: 2, elevation: 2, padding: 4 }}
        >
          <Icon name="TimerOff" size={14} color={colors.foregroundMuted} />
        </Pressable>
      ) : null}
      {!deferred && props.onDefer ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="延迟显示"
          hitSlop={6}
          onPress={function defer() {
            props.onDefer?.(session);
          }}
          style={{ position: "absolute", top: 6, right: 6, zIndex: 2, elevation: 2, padding: 4 }}
        >
          <Icon name="Timer" size={14} color={colors.foregroundMuted} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

export const SessionCard = memo(SessionCardView);
