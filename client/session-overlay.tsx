/**
 * Large self-drawn detail overlay: status/analysis/actions on the left (1/3),
 * the live agent conversation on the right (2/3). Compact layouts show the same
 * content as two tabs (概览 / 会话).
 */
import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { analysisStatusLabel, resumeStateLabel, sessionTitle } from "../shared/presentation";
import { isActiveLiveness, type SessionDetail } from "../shared/types";
import { Badge, Chip } from "./badge";
import { ConversationPane } from "./conversation/conversation-pane";
import { DeferMenu } from "./defer-menu";
import { DetailContent, useDetailActions } from "./detail-content";
import { columnTone, errorText, statusTone } from "./styles";
import { markDeferEndSeen, useDetail } from "./use-snapshot";

type Props = {
  sessionId: string | null;
  theme: PluginTheme;
  compact: boolean;
  navigation: PluginScreenProps["navigation"];
  onClose(): void;
};

type Tab = "overview" | "conversation";

export function SessionOverlay(props: Props) {
  const { sessionId, theme, compact, onClose } = props;
  const { colors } = theme;
  const detail = useDetail(sessionId);
  const [deferOpen, setDeferOpen] = useState(false);
  const queryClient = useQueryClient();
  const deferEndedAt = detail.data?.session?.deferEndedAt ?? null;
  // Opening the card marks an ended defer as seen; the server already cleared
  // it in this detail call, the patch only skips the wait for the next poll.
  useEffect(
    function markSeen() {
      if (sessionId !== null && deferEndedAt !== null) {
        markDeferEndSeen(queryClient, sessionId);
      }
    },
    [queryClient, sessionId, deferEndedAt],
  );
  if (sessionId === null) {
    return null;
  }
  const session = detail.data?.session ?? null;

  const openDefer = session
    ? function open() {
        setDeferOpen(true);
      }
    : undefined;

  let body;
  if (detail.isLoading) {
    body = (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  } else if (detail.isError && session === null) {
    body = (
      <View style={{ padding: 16 }}>
        <Text style={{ color: colors.statusDanger, fontSize: 13 }}>
          {`加载失败：${errorText(detail.error)}`}
        </Text>
      </View>
    );
  } else if (session === null) {
    body = (
      <View style={{ padding: 16 }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>
          会话不存在或已从看板移除。
        </Text>
      </View>
    );
  } else {
    body = (
      <OverlayBody
        key={session.id}
        session={session}
        theme={theme}
        compact={compact}
        onDefer={openDefer}
      />
    );
  }

  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 2000,
        elevation: 24,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="关闭详情"
        onPress={onClose}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: "rgba(0,0,0,0.5)",
        }}
      />
      <View
        style={{
          width: compact ? "100%" : "92%",
          height: compact ? "100%" : "92%",
          maxWidth: compact ? undefined : 1400,
          borderRadius: compact ? 0 : 14,
          borderWidth: compact ? 0 : 1,
          borderColor: colors.border,
          backgroundColor: colors.surface0,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingHorizontal: 14,
            paddingVertical: 10,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
          }}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 15, fontWeight: "700" }}>
              {session ? sessionTitle(session) : "会话详情"}
            </Text>
            {session ? (
              <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 12 }}>
                {`${session.provider}${session.model ? ` · ${session.model}` : ""}`}
              </Text>
            ) : null}
          </View>
          {session ? (
            <HeaderActions
              key={session.id}
              session={session}
              theme={theme}
              navigation={props.navigation}
              onClose={onClose}
            />
          ) : null}
          {session ? <HeaderBadges session={session} theme={theme} /> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭"
            hitSlop={8}
            onPress={onClose}
            style={{ padding: 6 }}
          >
            <Icon name="X" size={18} color={colors.foregroundMuted} />
          </Pressable>
        </View>
        <View style={{ flex: 1, minHeight: 0 }}>{body}</View>
      </View>
      <DeferMenu
        session={deferOpen ? session : null}
        theme={theme}
        now={Date.now()}
        onClose={function close() {
          setDeferOpen(false);
        }}
      />
    </View>
  );
}

function HeaderIconButton(props: {
  theme: PluginTheme;
  icon: string;
  label: string;
  onPress(): void;
  disabled?: boolean;
  danger?: boolean;
}) {
  const { colors } = props.theme;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={4}
      disabled={props.disabled === true}
      onPress={props.onPress}
      style={{ padding: 6, borderRadius: 6, opacity: props.disabled === true ? 0.4 : 1 }}
    >
      <Icon
        name={props.icon}
        size={16}
        color={props.danger === true ? colors.statusDanger : colors.foregroundMuted}
      />
    </Pressable>
  );
}

function HeaderActions(props: {
  session: SessionDetail;
  theme: PluginTheme;
  navigation: PluginScreenProps["navigation"];
  onClose(): void;
}) {
  const { theme } = props;
  const act = useDetailActions({
    session: props.session,
    navigation: props.navigation,
    onClose: props.onClose,
  });
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
      {act.openAgent ? (
        <HeaderIconButton theme={theme} icon="ExternalLink" label="打开 Agent" onPress={act.openAgent} />
      ) : null}
      <HeaderIconButton
        theme={theme}
        icon="RefreshCw"
        label="重新分析"
        disabled={act.reanalyzeDisabled}
        onPress={act.reanalyze}
      />
      {act.applyGeneratedTitle ? (
        <HeaderIconButton theme={theme} icon="Sparkles" label="应用生成标题" onPress={act.applyGeneratedTitle} />
      ) : null}
      {act.archiveSession ? (
        <HeaderIconButton
          theme={theme}
          icon={act.archiveConfirming ? "ArchiveX" : "Archive"}
          label={act.archiveConfirming ? "再次点击确认归档" : "归档"}
          danger={act.archiveConfirming}
          disabled={act.archiveBusy}
          onPress={act.archiveSession}
        />
      ) : null}
      {act.forgetSession ? (
        <HeaderIconButton theme={theme} icon="EyeOff" label="从看板移除" onPress={act.forgetSession} />
      ) : null}
    </View>
  );
}

function HeaderBadges(props: { session: SessionDetail; theme: PluginTheme }) {
  const { session, theme } = props;
  const active = isActiveLiveness(session.liveness);
  const resume = resumeStateLabel(session);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {resume !== null ? (
        <Badge
          theme={theme}
          label={resume}
          tone={
            session.resumeState === "failed"
              ? theme.colors.statusDanger
              : theme.colors.foregroundMuted
          }
        />
      ) : null}
      <Badge
        theme={theme}
        label={active ? analysisStatusLabel(session.effectiveStatus) : "已关闭"}
        tone={active ? statusTone(theme, session.effectiveStatus) : columnTone(theme, "closed")}
      />
      {session.pendingPermissionCount > 0 ? (
        <Badge theme={theme} label="待确认" tone={theme.colors.statusWarning} />
      ) : null}
    </View>
  );
}

function OverlayBody(props: {
  session: SessionDetail;
  theme: PluginTheme;
  compact: boolean;
  onDefer?(): void;
}) {
  const { session, theme, compact } = props;
  // Dormant sessions reopen the conversation tab: sending a message resumes them.
  const active = isActiveLiveness(session.liveness);
  const [tab, setTab] = useState<Tab>(active ? "conversation" : "overview");

  const overview = (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 14, gap: 16 }}
      keyboardShouldPersistTaps="handled"
    >
      <DetailContent session={session} theme={theme} onDefer={props.onDefer} />
    </ScrollView>
  );
  const conversation = (
    <ConversationPane sessionId={session.id} theme={theme} live={active} compact={compact} />
  );

  if (compact) {
    return (
      <View style={{ flex: 1, minHeight: 0 }}>
        <View style={{ flexDirection: "row", gap: 6, padding: 8 }}>
          <Chip
            theme={theme}
            label="概览"
            selected={tab === "overview"}
            onPress={function showOverview() {
              setTab("overview");
            }}
          />
          <Chip
            theme={theme}
            label="会话"
            selected={tab === "conversation"}
            onPress={function showConversation() {
              setTab("conversation");
            }}
          />
        </View>
        <View style={{ flex: 1, minHeight: 0 }}>
          {tab === "overview" ? overview : conversation}
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, minHeight: 0, flexDirection: "row" }}>
      <View
        style={{
          flex: 1,
          minWidth: 0,
          borderRightWidth: 1,
          borderRightColor: theme.colors.border,
        }}
      >
        {overview}
      </View>
      <View style={{ flex: 2, minWidth: 0 }}>{conversation}</View>
    </View>
  );
}
