import type { PluginTheme } from "@getpaseo/plugin";
import { memo } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import {
  analysisStateLabel,
  branchLabel,
  firstLine,
  formatShortTimeAgo,
  sessionTitle,
  workspaceLabel,
} from "../shared/presentation";
import type { SessionView } from "../shared/types";
import { Badge } from "./badge";

type Props = {
  session: SessionView;
  theme: PluginTheme;
  now: number;
  onOpen?(session: SessionView): void;
};

function SessionCardView(props: Props) {
  const { session, theme, now } = props;
  const { colors } = theme;
  const branch = branchLabel(session);
  const nextStep = firstLine(session.analysis?.nextSteps[0], 120);
  const summary = firstLine(session.analysis?.summary, 160);
  const working = session.liveness === "live" && session.lifecycle === "working";
  const running = session.analysisState === "running" || session.analysisState === "queued";
  const attention = session.analysis?.needsUserAttention === true && session.liveness === "live";

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
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text
          numberOfLines={1}
          style={{ flex: 1, color: colors.foreground, fontSize: 13, fontWeight: "600" }}
        >
          {sessionTitle(session)}
        </Text>
        {working || running ? (
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
    </Pressable>
  );
}

export const SessionCard = memo(SessionCardView);
