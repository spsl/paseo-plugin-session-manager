import { useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { workspaceActivity } from "../shared/launch";
import { COLUMNS } from "../shared/presentation";
import { ANALYZER_SETTINGS, DEFAULT_ANALYZER_SETTINGS } from "../shared/settings";
import {
  buildProjectFilter,
  buildProjectWorkspaces,
  filterSessionsByProjectSearch,
  retainAvailableProjectSelection,
  searchProjectOptions,
} from "../shared/project-filter";
import type { BoardColumn, SessionView } from "../shared/types";
import { isDesktop, isFullscreen, setFullscreen } from "./desktop-bridge";
import { FALLBACK_HINT, NOTICE_NO_WINDOW, openBoardInNewWindow } from "./open-board-window";
import { useSnapshotNudges } from "./agents-watch";
import { Chip } from "./badge";
import {
  expandedCardIds,
  groupBoardCards,
  openCardCount,
  projectCardCounts,
  reduceExpansion,
  workspaceKeyOf,
  workspaceLabelOf,
  type ExpansionState,
} from "./board-model";
import { SingleColumn, WideColumns } from "./board-columns";
import { DeferMenu } from "./defer-menu";
import { LaunchDialog } from "./launch-dialog";
import { ProjectSearch } from "./project-search";
import { SessionOverlay } from "./session-overlay";
import { WorkspacePicker, type WorkspacePickTarget } from "./workspace-picker";
import { columnTone, errorText } from "./styles";
import { SNAPSHOT_QUERY_KEY, useSessionActions, useSnapshot } from "./use-snapshot";

/**
 * A screen is given no way to open a settings screen, so index.client.tsx lends
 * the capability here (same pattern as herald's bindSettingsOpener).
 */
let openSettingsScreen: ((id: string) => void) | null = null;

export function bindSettingsOpener(open: ((id: string) => void) | null): void {
  openSettingsScreen = open;
}

export const SETTINGS_SCREEN_ID = "session-manager";

/**
 * `params.launch` opens the 新建会话 dialog (the Command Center passes a fresh
 * nonce); each nonce opens it once, so returning to the screen does not.
 */
export const LAUNCH_PARAM = "launch";
const consumedLaunches = new Set<string>();

/** How long a just-created session may take to reach the board before the detail gives up. */
const FRESH_SESSION_MS = 15_000;

function initExpansion(hitChildId: string | null): ExpansionState {
  return { toggled: new Set<string>(), hitChildId };
}

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
  const settings = useSettings(ANALYZER_SETTINGS);
  const columnWidthPercent =
    settings.status === "ready"
      ? settings.values.columnWidthPercent
      : DEFAULT_ANALYZER_SETTINGS.columnWidthPercent;
  const now = useNow(30_000);
  useSnapshotNudges();

  const [openId, setOpenId] = useState<string | null>(params.sessionId ?? null);
  const paramSessionId = params.sessionId ?? null;
  // A deep-linked session that turns out to be an embedded sub-agent stays a
  // "hit": its card keeps the hit row expanded and highlighted after the detail
  // closes, until the next hit or a manual collapse of that card.
  const [expansion, dispatchExpansion] = useReducer(reduceExpansion, paramSessionId, initExpansion);
  useEffect(
    function syncParam() {
      if (paramSessionId !== null) {
        setOpenId(paramSessionId);
        dispatchExpansion({ type: "hit", childId: paramSessionId });
      }
    },
    [paramSessionId],
  );

  const queryClient = useQueryClient();
  const [launchOpen, setLaunchOpen] = useState(false);
  const launchParam = params[LAUNCH_PARAM] ?? null;
  useEffect(
    function openLaunch() {
      if (launchParam !== null && !consumedLaunches.has(launchParam)) {
        consumedLaunches.add(launchParam);
        setLaunchOpen(true);
      }
    },
    [launchParam],
  );
  // The session just created from the dialog: its detail waits for the
  // plugin to pick it up instead of reporting it missing.
  const [freshId, setFreshId] = useState<string | null>(null);
  useEffect(
    function expireFresh() {
      if (freshId === null) {
        return undefined;
      }
      const timer = setTimeout(function expire() {
        setFreshId(null);
      }, FRESH_SESSION_MS);
      return function stop() {
        clearTimeout(timer);
      };
    },
    [freshId],
  );
  const onLaunched = useCallback(
    function launched(agentId: string) {
      setLaunchOpen(false);
      setFreshId(agentId);
      setOpenId(agentId);
      void queryClient.invalidateQueries({ queryKey: SNAPSHOT_QUERY_KEY });
    },
    [queryClient],
  );

  const standalone = params.standalone === "1";
  const desktop = isDesktop();
  const [fullscreen, setFullscreenState] = useState(false);
  useEffect(
    function readFullscreen() {
      if (!desktop) {
        return;
      }
      let alive = true;
      void isFullscreen().then(function apply(value) {
        if (alive && value !== null) {
          setFullscreenState(value);
        }
      });
      return function stop() {
        alive = false;
      };
    },
    [desktop],
  );
  const toggleFullscreen = useCallback(
    function toggle() {
      const next = !fullscreen;
      if (setFullscreen(next)) {
        setFullscreenState(next);
      }
    },
    [fullscreen],
  );
  const openWindow = useCallback(
    function open() {
      if (!openBoardInNewWindow()) {
        toast.show(FALLBACK_HINT, { variant: "warning", durationMs: 8000 });
      }
    },
    [toast],
  );
  const notice = params.notice ?? null;
  useEffect(
    function showNotice() {
      if (notice === NOTICE_NO_WINDOW) {
        toast.show(FALLBACK_HINT, { variant: "warning", durationMs: 8000 });
      }
    },
    [notice, toast],
  );

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [activeColumn, setActiveColumn] = useState<BoardColumn>("waiting_for_user");
  const [workspaceKey, setWorkspaceKey] = useState<string | null>(params.workspace ?? null);
  const paramWorkspace = params.workspace ?? null;
  useEffect(
    function syncWorkspace() {
      setWorkspaceKey(paramWorkspace);
    },
    [paramWorkspace],
  );

  const allSessions = useMemo(
    function all(): readonly SessionView[] {
      return snapshot.data?.sessions ?? [];
    },
    [snapshot.data],
  );
  // The unfiltered layout is the baseline for global numbers; per-project and
  // per-workspace counts come from each filtered view's own layout instead.
  const totalLayout = useMemo(
    function total() {
      return groupBoardCards(allSessions, allSessions, now);
    },
    [allSessions, now],
  );
  const filter = useMemo(
    function build() {
      return buildProjectFilter(allSessions);
    },
    [allSessions],
  );
  const workspacesByProject = useMemo(
    function workspaces() {
      return buildProjectWorkspaces(allSessions, filter.projectKeyBySessionId);
    },
    [allSessions, filter],
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
  // null while the search box is blank; otherwise the matching chips.
  const hits = useMemo(
    function search() {
      return searchProjectOptions(filter.options, query);
    },
    [filter.options, query],
  );
  // A selected chip the search hides stays selected for when the search
  // clears, but only the chips still shown count as the current selection.
  const visibleSelection = useMemo(
    function visible() {
      return hits === null ? selected : retainAvailableProjectSelection(selected, hits);
    },
    [selected, hits],
  );
  const sessions = useMemo(
    function filtered() {
      const byProject = filterSessionsByProjectSearch(
        allSessions,
        filter.projectKeyBySessionId,
        selected,
        hits,
      );
      if (workspaceKey === null) {
        return byProject;
      }
      return byProject.filter(function inWorkspace(session) {
        return workspaceKeyOf(session) === workspaceKey;
      });
    },
    [allSessions, filter, selected, hits, workspaceKey],
  );
  const workspaceLabel = useMemo(
    function label() {
      if (workspaceKey === null) {
        return null;
      }
      const hit = allSessions.find(function match(session) {
        return workspaceKeyOf(session) === workspaceKey;
      });
      return hit === undefined ? workspaceKey : workspaceLabelOf(hit);
    },
    [allSessions, workspaceKey],
  );
  // The full snapshot walks the parentAgentId chain; the filtered list decides
  // which sessions get cards. A sub-agent embeds into its topmost visible
  // non-closed ancestor, so a card never moves columns because of a child.
  const boardLayout = useMemo(
    function group() {
      return sessions === allSessions
        ? totalLayout
        : groupBoardCards(sessions, allSessions, now);
    },
    [sessions, allSessions, totalLayout, now],
  );
  const groups = boardLayout.groups;
  // A hit on an embedded child keeps its parent card expanded and its row lit.
  const focusChildId =
    expansion.hitChildId !== null && boardLayout.hostByChildId.has(expansion.hitChildId)
      ? expansion.hitChildId
      : null;
  const focusHostId =
    focusChildId === null ? null : (boardLayout.hostByChildId.get(focusChildId) ?? null);
  const expandedIds = useMemo(
    function expand() {
      return expandedCardIds(expansion.toggled, focusChildId, boardLayout.hostByChildId);
    },
    [expansion.toggled, focusChildId, boardLayout],
  );
  // dispatch is stable, so reading the latest host map through a ref keeps
  // this callback referentially stable across snapshot polls and toggles.
  const hostByChildIdRef = useRef(boardLayout.hostByChildId);
  useEffect(
    function syncHost() {
      hostByChildIdRef.current = boardLayout.hostByChildId;
    },
    [boardLayout],
  );
  const onToggleSubagents = useCallback(function toggle(parentId: string) {
    dispatchExpansion({
      type: "toggle",
      cardId: parentId,
      hostByChildId: hostByChildIdRef.current,
    });
  }, []);

  const actions = useSessionActions();
  const [deferTarget, setDeferTarget] = useState<SessionView | null>(null);
  const onDefer = useCallback(function defer(session: SessionView) {
    setDeferTarget(session);
  }, []);
  const onResume = useCallback(
    function resume(session: SessionView) {
      void actions.clearDefer(session.id);
    },
    [actions],
  );
  const onReopen = useCallback(
    function reopen(session: SessionView) {
      void actions.reopen(session.id);
    },
    [actions],
  );

  const onOpen = useCallback(function open(session: SessionView) {
    setOpenId(session.id);
  }, []);

  const [workspacePick, setWorkspacePick] = useState<WorkspacePickTarget | null>(null);
  // Jumping away would replace the board itself in a standalone window, so
  // only the board embedded in the main window offers it.
  const openWorkspace =
    navigation !== undefined && !standalone
      ? function open(workspaceId: string) {
          setWorkspacePick(null);
          navigation.openWorkspace({ workspaceId });
        }
      : null;

  function toggleProject(key: string): void {
    const next = new Set(selected);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    setSelected(next);
  }

  const cardTotal = allSessions.length - totalLayout.hostByChildId.size;
  const visibleCards = sessions.length - boardLayout.hostByChildId.size;
  // Each chip counts the open cards of its own single-project view, so a
  // sub-agent detached by the filter counts toward its project; "全部项目"
  // uses the unfiltered layout rather than summing chips.
  const cardCountByProjectKey = useMemo(
    function counts() {
      return projectCardCounts(
        allSessions,
        filter.projectKeyBySessionId,
        filter.options.map(function keyOf(option) {
          return option.key;
        }),
        now,
      );
    },
    [allSessions, filter, now],
  );
  // Under a search "全部项目" means every hit, so it counts only their cards.
  const searchLayout = useMemo(
    function searched() {
      if (hits === null) {
        return totalLayout;
      }
      const inHits = filterSessionsByProjectSearch(
        allSessions,
        filter.projectKeyBySessionId,
        new Set(),
        hits,
      );
      return groupBoardCards(inHits, allSessions, now);
    },
    [hits, allSessions, filter, totalLayout, now],
  );
  const openTotal = openCardCount(searchLayout);
  const filtered = selected.size > 0 || workspaceKey !== null || hits !== null;
  // N / M is cards vs sessions inside the current view, so N can never exceed
  // M even when a filter detaches a sub-agent into its own card.
  const countLabel = filtered
    ? `${visibleCards} / ${sessions.length} 个会话`
    : `${cardTotal} 个会话`;
  const problem = snapshot.data?.analyzer.problem ?? null;

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
          expandedIds={expandedIds}
          focusChildId={focusChildId}
          focusHostId={focusHostId}
          onOpen={onOpen}
          onToggleSubagents={onToggleSubagents}
          onDefer={onDefer}
          onResume={onResume}
          onReopen={onReopen}
          columnId={activeColumn}
        />
      </View>
    );
  } else {
    body = (
      <WideColumns
        theme={theme}
        now={now}
        groups={groups}
        expandedIds={expandedIds}
        focusChildId={focusChildId}
        focusHostId={focusHostId}
        onOpen={onOpen}
        onToggleSubagents={onToggleSubagents}
        onDefer={onDefer}
        onResume={onResume}
        onReopen={onReopen}
        columnWidthPercent={columnWidthPercent}
      />
    );
  }

  const search = <ProjectSearch theme={theme} value={query} onChange={setQuery} />;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 12,
          paddingTop: standalone ? 6 : 12,
        }}
      >
        <View style={compact ? { flex: 1, gap: 2 } : { gap: 2 }}>
          <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "700" }}>会话看板</Text>
          {standalone ? null : (
            <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
              根据当前执行状态与最新分析结论归类
            </Text>
          )}
        </View>
        {compact ? null : <View style={{ flex: 1, marginHorizontal: 12 }}>{search}</View>}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="新建会话"
          hitSlop={compact ? 8 : 4}
          onPress={function openLaunch() {
            setLaunchOpen(true);
          }}
          style={function launchStyle(state) {
            return {
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              paddingHorizontal: compact ? 6 : 10,
              paddingVertical: 6,
              borderRadius: 8,
              backgroundColor: compact ? "transparent" : colors.accent,
              opacity: state.pressed ? 0.8 : 1,
            };
          }}
        >
          <Icon name="Plus" size={compact ? 18 : 14} color={compact ? colors.foregroundMuted : colors.accentForeground} />
          {compact ? null : (
            <Text style={{ color: colors.accentForeground, fontSize: 12, fontWeight: "600" }}>新建会话</Text>
          )}
        </Pressable>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{countLabel}</Text>
        {desktop && !standalone ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="新窗口打开"
            hitSlop={8}
            onPress={openWindow}
            style={{ padding: 6 }}
          >
            <Icon name="AppWindow" size={18} color={colors.foregroundMuted} />
          </Pressable>
        ) : null}
        {desktop ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={fullscreen ? "退出全屏" : "全屏"}
            hitSlop={8}
            onPress={toggleFullscreen}
            style={{ padding: 6 }}
          >
            <Icon
              name={fullscreen ? "Minimize" : "Maximize"}
              size={18}
              color={colors.foregroundMuted}
            />
          </Pressable>
        ) : null}
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

      {compact ? <View style={{ paddingHorizontal: 12, paddingTop: 8 }}>{search}</View> : null}

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

      {workspaceLabel !== null ? (
        <View style={{ flexDirection: "row", paddingHorizontal: 12, paddingTop: 8 }}>
          <Chip
            theme={theme}
            label={`${workspaceLabel} ×`}
            selected
            onPress={function clearWorkspace() {
              setWorkspaceKey(null);
            }}
          />
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
            label={`全部项目（${openTotal}）`}
            selected={visibleSelection.size === 0}
            onPress={function clear() {
              setSelected(new Set());
            }}
          />
          {(hits ?? filter.options).map(function renderOption(option) {
            const workspaces = workspacesByProject.get(option.key) ?? [];
            const accessory =
              openWorkspace === null || workspaces.length === 0
                ? undefined
                : {
                    icon: "ExternalLink",
                    label: `在 Paseo 中打开 ${option.label}`,
                    onPress: function jump() {
                      const only = workspaces.length === 1 ? workspaces[0] : undefined;
                      if (only !== undefined) {
                        openWorkspace(only.workspaceId);
                      } else {
                        setWorkspacePick({ projectLabel: option.label, workspaces });
                      }
                    },
                  };
            return (
              <Chip
                key={option.key}
                theme={theme}
                label={`${option.label}（${cardCountByProjectKey.get(option.key) ?? 0}）`}
                selected={selected.has(option.key)}
                highlighted={hits !== null}
                accessory={accessory}
                onPress={function toggle() {
                  toggleProject(option.key);
                }}
              />
            );
          })}
          {hits !== null && hits.length === 0 ? (
            <Text style={{ alignSelf: "center", color: colors.foregroundMuted, fontSize: 12 }}>
              没有匹配的项目
            </Text>
          ) : null}
        </ScrollView>
      ) : null}

      <View style={{ flex: 1, minHeight: 0 }}>{body}</View>

      <SessionOverlay
        sessionId={openId}
        theme={theme}
        compact={compact}
        navigation={navigation}
        awaitingNew={openId !== null && openId === freshId}
        onClose={function close() {
          setOpenId(null);
        }}
      />

      {launchOpen ? (
        <LaunchDialog
          theme={theme}
          compact={compact}
          initialQuery={query}
          boardWorkspaceKey={workspaceKey}
          recentActivity={workspaceActivity(allSessions)}
          onClose={function closeLaunch() {
            setLaunchOpen(false);
          }}
          onCreated={onLaunched}
        />
      ) : null}

      <WorkspacePicker
        target={workspacePick}
        theme={theme}
        onPick={function pick(workspaceId) {
          openWorkspace?.(workspaceId);
        }}
        onClose={function close() {
          setWorkspacePick(null);
        }}
      />

      <DeferMenu
        session={deferTarget}
        theme={theme}
        now={now}
        onClose={function close() {
          setDeferTarget(null);
        }}
      />
    </View>
  );
}
