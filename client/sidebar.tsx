import type { PluginPopoverProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Pressable, Text, View } from "react-native";
import { firstLine, sessionTitle } from "../shared/presentation";
import { useSnapshotNudges } from "./agents-watch";
import { attentionSessions, workspaceAttentionGroups } from "./board-model";
import { toneBackground } from "./styles";
import { useSnapshot } from "./use-snapshot";

export const BOARD_SCREEN_ID = "board";

export function BoardSidebarItem({ theme, currentScreen, openScreen, openPopover }: PluginSidebarItemProps) {
  const snapshot = useSnapshot();
  useSnapshotNudges();
  const sessions = snapshot.data?.sessions ?? [];
  const count = sessions.filter(function needs(session) {
    return session.needsAttention;
  }).length;
  const workspaces = workspaceAttentionGroups(sessions).slice(0, 8);
  const warning = theme.colors.statusWarning;

  function badge(value: number) {
    return (
      <View
        style={{
          minWidth: 18,
          paddingHorizontal: 5,
          paddingVertical: 1,
          borderRadius: 9,
          alignItems: "center",
          backgroundColor: toneBackground(theme, warning),
        }}
      >
        <Text style={{ color: warning, fontSize: 11, fontWeight: "600" }}>{value}</Text>
      </View>
    );
  }

  return (
    <>
      <SidebarRow
        icon="Kanban"
        label="会话看板"
        active={currentScreen?.screenId === BOARD_SCREEN_ID}
        trailing={
          count === 0 ? undefined : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${count} 个会话需要处理，点击查看`}
              hitSlop={6}
              onPress={function show() {
                openPopover(AttentionPopover);
              }}
            >
              {badge(count)}
            </Pressable>
          )
        }
        onPress={function open() {
          openScreen({ screenId: BOARD_SCREEN_ID });
        }}
      />
      {workspaces.map(function renderWorkspace(group) {
        return (
          <SidebarRow
            key={group.key}
            id={`workspace-${group.key}`}
            icon="Folder"
            label={group.label}
            trailing={badge(group.attentionCount)}
            onPress={function open() {
              openScreen({
                screenId: BOARD_SCREEN_ID,
                params: { workspace: group.key },
              });
            }}
          />
        );
      })}
    </>
  );
}

function AttentionPopover({ theme, openScreen, close }: PluginPopoverProps) {
  const snapshot = useSnapshot();
  const { colors } = theme;
  const items = attentionSessions(snapshot.data?.sessions ?? [], 8);
  return (
    <View style={{ gap: 2 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>
        {items.length === 0 ? "会话看板" : `${items.length} 个会话需要处理`}
      </Text>
      {items.length === 0 ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: 13, padding: 8 }}>暂无需要处理的会话。</Text>
      ) : null}
      {items.map(function renderItem(session) {
        const next = firstLine(session.analysis?.nextSteps[0], 80);
        return (
          <Pressable
            key={session.id}
            accessibilityRole="button"
            onPress={function open() {
              openScreen({ screenId: BOARD_SCREEN_ID, params: { sessionId: session.id } });
              close();
            }}
            style={function rowStyle({ pressed }) {
              return {
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 8,
                paddingVertical: 6,
                borderRadius: 6,
                backgroundColor: pressed ? colors.surface2 : "transparent",
              };
            }}
          >
            <Icon name="CircleAlert" size={14} color={colors.statusWarning} />
            <View style={{ flex: 1, gap: 1 }}>
              <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>
                {sessionTitle(session)}
              </Text>
              {next ? (
                <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 12 }}>
                  {`下一步：${next}`}
                </Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}
      <Pressable
        accessibilityRole="button"
        onPress={function openBoard() {
          openScreen({ screenId: BOARD_SCREEN_ID });
          close();
        }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 8,
          paddingVertical: 6,
          marginTop: 4,
          borderTopWidth: 1,
          borderTopColor: colors.border,
        }}
      >
        <Icon name="Kanban" size={14} color={colors.accent} />
        <Text style={{ color: colors.accent, fontSize: 13 }}>打开会话看板</Text>
      </Pressable>
    </View>
  );
}
