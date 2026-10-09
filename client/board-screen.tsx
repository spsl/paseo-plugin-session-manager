import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Animated, Pressable, ScrollView, Text, View } from "react-native";
import { COLUMNS } from "../shared/presentation";
import {
  buildProjectFilter,
  filterSessionsByProject,
  retainAvailableProjectSelection,
} from "../shared/project-filter";
import type { AnalysisStatus, BoardColumn, SessionView } from "../shared/types";
import { useSnapshotNudges } from "./agents-watch";
import { Chip } from "./badge";
import { groupByColumn } from "./board-model";
import { SingleColumn, WideColumns } from "./board-columns";
import { SessionCard } from "./session-card";
import { SessionOverlay } from "./session-overlay";
import { columnTone, errorText } from "./styles";
import { useBoardDrag } from "./use-board-drag";
import { useSessionActions, useSnapshot } from "./use-snapshot";

/**
 * A screen is given no way to open a settings screen, so index.client.tsx lends
 * the capability here (same pattern as herald's bindSettingsOpener).
 */
let openSettingsScreen: ((id: string) => void) | null = null;

export function bindSettingsOpener(open: ((id: string) => void) | null): void {
  openSettingsScreen = open;
}

export const SETTINGS_SCREEN_ID = "session-manager";

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(
    function tick() {
      const timer = setInterval(function update() {
        setNow(Date.now());
      }, intervalMs);
      return function stop() {
        clearInterval(timer);
      };
    },
    [intervalMs],
  );
  return now;
}

export function BoardScreen(props: PluginScreenProps) {
  const { theme, layout, params, navigation } = props;
  const { colors } = theme;
  const compact = layout.compact;
  const toast = useToast();
  const snapshot = useSnapshot();
  const actions = useSessionActions();
  const now = useNow(30_000);
  useSnapshotNudges();

  const [openId, setOpenId] = useState<string | null>(params.sessionId ?? null);
  const paramSessionId = params.sessionId ?? null;
  useEffect(
    function syncParam() {
      if (paramSessionId !== null) {
        setOpenId(paramSessionId);
      }
    },
    [paramSessionId],
  );

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [activeColumn, setActiveColumn] = useState<BoardColumn>("waiting_for_user");

  const allSessions = useMemo(
    function all(): readonly SessionView[] {
      return snapshot.data?.sessions ?? [];
    },
    [snapshot.data],
  );
  const filter = useMemo(
    function build() {
      return buildProjectFilter(allSessions);
    },
    [allSessions],
  );
  useEffect(
    function retain() {
      setSelected(function keep(current) {
        const next = retainAvailableProjectSelection(current, filter.options);
        return next.size === current.size ? current : next;
      });
    },
    [filter.options],
  );
  const sessions = useMemo(
    function filtered() {
      return filterSessionsByProject(allSessions, filter.projectKeyBySessionId, selected);
    },
    [allSessions, filter, selected],
  );
  const groups = useMemo(
    function group() {
      return groupByColumn(sessions);
    },
    [sessions],
  );

  const onDrop = useCallback(
    function onDrop(session: SessionView, status: AnalysisStatus) {
      void actions.setManualStatus(session.id, status);
    },
    [actions],
  );
  const onReject = useCallback(
    function onReject(message: string) {
      toast.show(message, { variant: "warning" });
    },
    [toast],
  );
  const drag = useBoardDrag({ enabled: !compact, onDrop, onReject });

  const onOpen = useCallback(function open(session: SessionView) {
    setOpenId(session.id);
  }, []);

  function toggleProject(key: string): void {
    const next = new Set(selected);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    setSelected(next);
  }

  const total = allSessions.length;
  const countLabel =
    selected.size === 0 ? `${total} 个会话` : `${sessions.length} / ${total} 个会话`;
  const problem = snapshot.data?.analyzer.problem ?? null;
  const dragApi = compact ? null : drag;

  let body;
  if (snapshot.data === undefined && snapshot.isError) {
    body = (
      <View style={{ padding: 24, gap: 8, alignItems: "center" }}>
        <Text style={{ color: colors.statusDanger, fontSize: 13 }}>
          {`加载失败：${errorText(snapshot.error)}`}
        </Text>
        <Chip
          theme={theme}
          label="重试"
          selected={false}
          onPress={function retry() {
            void snapshot.refetch();
          }}
        />
      </View>
    );
  } else if (snapshot.data === undefined) {
    body = (
      <View style={{ padding: 24, alignItems: "center", gap: 8 }}>
        <ActivityIndicator color={colors.accent} />
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>正在加载会话…</Text>
      </View>
    );
  } else if (compact) {
    body = (
      <View style={{ flex: 1 }}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0 }}
          contentContainerStyle={{ gap: 6, paddingHorizontal: 12, paddingVertical: 8 }}
        >
          {COLUMNS.map(function renderTab(column) {
            return (
              <Chip
                key={column.id}
                theme={theme}
                label={`${column.label} ${groups[column.id].length}`}
                tone={columnTone(theme, column.id)}
                selected={activeColumn === column.id}
                onPress={function select() {
                  setActiveColumn(column.id);
                }}
              />
            );
          })}
        </ScrollView>
        <SingleColumn
          theme={theme}
          now={now}
          groups={groups}
          drag={null}
          onOpen={onOpen}
          columnId={activeColumn}
        />
      </View>
    );
  } else {
    body = <WideColumns theme={theme} now={now} groups={groups} drag={dragApi} onOpen={onOpen} />;
  }

  return (
    <View
      ref={drag.rootRef}
      collapsable={false}
      style={{ flex: 1, backgroundColor: colors.surface0 }}
      {...(compact ? {} : drag.panHandlers)}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 12,
          paddingTop: 12,
        }}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "700" }}>会话看板</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
            根据当前执行状态与最新分析结论归类
          </Text>
        </View>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{countLabel}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="会话看板设置"
          hitSlop={8}
          onPress={function openSettings() {
            openSettingsScreen?.(SETTINGS_SCREEN_ID);
          }}
          style={{ padding: 6 }}
        >
          <Icon name="Settings" size={18} color={colors.foregroundMuted} />
        </Pressable>
      </View>

      {problem ? (
        <View
          style={{
            marginHorizontal: 12,
            marginTop: 8,
            padding: 8,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: colors.statusWarning,
            backgroundColor: colors.surface1,
          }}
        >
          <Text style={{ color: colors.statusWarning, fontSize: 12, lineHeight: 17 }}>
            {`分析器不可用：${problem}`}
          </Text>
        </View>
      ) : null}

      {filter.options.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0 }}
          contentContainerStyle={{ gap: 6, paddingHorizontal: 12, paddingTop: 8 }}
        >
          <Chip
            theme={theme}
            label={`全部项目（${total}）`}
            selected={selected.size === 0}
            onPress={function clear() {
              setSelected(new Set());
            }}
          />
          {filter.options.map(function renderOption(option) {
            return (
              <Chip
                key={option.key}
                theme={theme}
                label={`${option.label}（${option.count}）`}
                selected={selected.has(option.key)}
                onPress={function toggle() {
                  toggleProject(option.key);
                }}
              />
            );
          })}
        </ScrollView>
      ) : null}

      <View style={{ flex: 1, minHeight: 0 }}>{body}</View>

      {drag.active ? (
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              width: drag.active.width,
              opacity: 0.9,
              zIndex: 1000,
              elevation: 12,
            },
            drag.ghost.getLayout(),
          ]}
        >
          <SessionCard session={drag.active.session} theme={theme} now={now} draggable={false} ghost />
        </Animated.View>
      ) : null}

      <SessionOverlay
        sessionId={openId}
        theme={theme}
        compact={compact}
        navigation={navigation}
        onClose={function close() {
          setOpenId(null);
        }}
      />
    </View>
  );
}
