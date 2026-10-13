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
import { isDeferred } from "./board-model";
import { withAlpha } from "./styles";

type Props = {
  session: SessionView;
  theme: PluginTheme;
  now: number;
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
        <View style={{ flex: 1 }} />
        <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
          {formatShortTimeAgo(session.updatedAt, now)}
        </Text>
      </View>
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
