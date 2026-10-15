/**
 * 新建会话 dialog on the board: type to pick a workspace, choose the agent,
 * model, thinking and permission mode (or one of Paseo's agent profiles),
 * write the first message, create. The agent is created through Paseo the
 * same way its own new-agent composer does, and the choice is remembered for
 * next time. Self-drawn overlay like the session detail (host Modal has no
 * size control).
 *
 * Keys on web: ↑/↓ move through workspaces, Enter jumps to the message,
 * Enter in the message creates (Shift+Enter is a newline), Esc clears the
 * search or closes. No async arrows, no closures inside for...of (Hermes).
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useSettings, type PluginClientContext } from "@getpaseo/plugin/client";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  type ScrollView as ScrollViewHandle,
  type TextInput as TextInputHandle,
} from "react-native";
import {
  DEFAULT_LAUNCH_SETTINGS,
  choiceFromProfile,
  effectiveSelection,
  findModel,
  initialChoice,
  LAUNCH_SETTINGS,
  launchConfig,
  launchProviders,
  moveSelection,
  preferredWorkspaceId,
  profileMatches,
  readProfiles,
  rememberLaunch,
  resolveChoice,
  searchWorkspaces,
  sortWorkspaces,
  toLaunchWorkspace,
  withModel,
  workspaceHeading,
  workspaceLabel,
  workspaceSubtitle,
  type LaunchChoice,
  type LaunchModel,
  type LaunchProfile,
  type LaunchProvider,
  type LaunchWorkspace,
} from "../shared/launch";
import { searchEntries } from "../shared/model-search";
import { Chip } from "./badge";
import { isImeComposing, type KeyInfo } from "./conversation/composer-logic";
import { modelCatalogFor } from "./conversation/model-catalog";
import {
  autofocusInput,
  domInputNode,
  focusInput,
  hasPrecisePointer,
} from "./conversation/web-attachments";
import { errorText, withAlpha } from "./styles";

type Paseo = PluginClientContext["paseo"];
type WorkspaceDescriptor = Awaited<ReturnType<Paseo["workspaces"]["list"]>>["entries"][number];

type KeyPressEvent = { nativeEvent: KeyInfo & { preventDefault?: () => void } };

const ROW_HEIGHT = 48;
const PAGE_LIMIT = 200;
const MAX_PAGES = 10;

/** The first message survives closing the dialog until a session is created. */
let promptDraft = "";

async function loadWorkspaces(paseo: Paseo): Promise<WorkspaceDescriptor[]> {
  const all: WorkspaceDescriptor[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result: Awaited<ReturnType<Paseo["workspaces"]["list"]>> = await paseo.workspaces.list({
      sort: [{ key: "activity_at", direction: "desc" }],
      page: cursor === null ? { limit: PAGE_LIMIT } : { limit: PAGE_LIMIT, cursor },
    });
    all.push(...result.entries);
    if (!result.pageInfo.hasMore || result.pageInfo.nextCursor === null) {
      break;
    }
    cursor = result.pageInfo.nextCursor;
  }
  return all;
}

async function loadProfiles(paseo: Paseo): Promise<LaunchProfile[]> {
  try {
    const result = await paseo.config.get();
    return readProfiles(result.config);
  } catch {
    // Profiles are a shortcut; without them the dialog still works.
    return [];
  }
}

type Loaded<T> = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; value: T };

export function LaunchDialog(props: {
  theme: PluginTheme;
  compact: boolean;
  /** Seeds the workspace search, e.g. with the board's project search. */
  initialQuery: string;
  /** The board's workspace filter key (`ws:<id>`), preselected when set. */
  boardWorkspaceKey: string | null;
  /** Latest session update per workspace id; orders the list by recency. */
  recentActivity: ReadonlyMap<string, number>;
  onClose(): void;
  onCreated(agentId: string): void;
}) {
  const { theme, compact } = props;
  const { colors } = theme;
  const paseo = usePaseo();
  const settings = useSettings(LAUNCH_SETTINGS);
  const settingsLoading = settings.status === "loading";
  const settingsValues = settings.status === "ready" ? settings.values : DEFAULT_LAUNCH_SETTINGS;

  const [workspaces, setWorkspaces] = useState<Loaded<LaunchWorkspace[]>>({ status: "loading" });
  const descriptorsRef = useRef(new Map<string, WorkspaceDescriptor>());
  const [providers, setProviders] = useState<Loaded<LaunchProvider[]>>({ status: "loading" });
  const [profiles, setProfiles] = useState<LaunchProfile[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Read when the list loads; the board's polls must not reload it.
  const recentActivityRef = useRef(props.recentActivity);
  recentActivityRef.current = props.recentActivity;

  function retry(): void {
    setWorkspaces({ status: "loading" });
    setProviders({ status: "loading" });
    setReloadKey(reloadKey + 1);
  }

  // Loads once per mount (and on 重试); cancelled only by unmount.
  const aliveRef = useRef(true);
  useEffect(function trackMount() {
    aliveRef.current = true;
    return function unmount() {
      aliveRef.current = false;
    };
  }, []);
  useEffect(
    function load() {
      loadWorkspaces(paseo).then(
        function apply(descriptors) {
          if (!aliveRef.current) {
            return;
          }
          const map = new Map<string, WorkspaceDescriptor>();
          const list: LaunchWorkspace[] = [];
          for (const descriptor of descriptors) {
            const workspace = toLaunchWorkspace(
              descriptor,
              recentActivityRef.current.get(descriptor.id) ?? 0,
            );
            if (workspace !== null) {
              map.set(workspace.id, descriptor);
              list.push(workspace);
            }
          }
          descriptorsRef.current = map;
          setWorkspaces({ status: "ready", value: sortWorkspaces(list) });
        },
        function fail(error: unknown) {
          if (aliveRef.current) {
            setWorkspaces({ status: "error", error: errorText(error) });
          }
        },
      );
      paseo.providers.snapshot().then(
        function apply(snapshot) {
          if (aliveRef.current) {
            setProviders({ status: "ready", value: launchProviders(snapshot.entries) });
          }
        },
        function fail(error: unknown) {
          if (aliveRef.current) {
            setProviders({ status: "error", error: errorText(error) });
          }
        },
      );
      void loadProfiles(paseo).then(function apply(list) {
        if (aliveRef.current) {
          setProfiles(list);
        }
      });
    },
    [paseo, reloadKey],
  );

  // ---- workspace search
  const [query, setQuery] = useState(props.initialQuery);
  // null until the user types, clicks or moves: the preferred workspace holds
  // until then; after it, an id or { id: null } for "the best hit".
  const [picked, setPicked] = useState<{ id: string | null } | null>(null);
  const preferredId = useMemo(
    function preferred() {
      return preferredWorkspaceId(props.boardWorkspaceKey, settingsValues);
    },
    [props.boardWorkspaceKey, settingsValues],
  );
  const hits = useMemo(
    function search() {
      return workspaces.status === "ready" ? searchWorkspaces(workspaces.value, query) : [];
    },
    [workspaces, query],
  );
  const workspaceId = effectiveSelection(hits, picked === null ? preferredId : picked.id);
  const workspace =
    hits.find(function match(hit) {
      return hit.id === workspaceId;
    }) ?? null;
  const listRef = useRef<ScrollViewHandle | null>(null);
  const searchRef = useRef<TextInputHandle | null>(null);
  const promptRef = useRef<TextInputHandle | null>(null);
  const isWeb = Platform.OS === "web";
  // A workspace filtered on the board is already the answer; go to the message.
  const startInPrompt = props.boardWorkspaceKey?.startsWith("ws:") ?? false;

  function focusPrompt(): void {
    if (isWeb) {
      focusInput(domInputNode(promptRef.current));
    } else {
      promptRef.current?.focus();
    }
  }

  // Same as the composer: the host may move focus for a moment after mount.
  useEffect(
    function autofocus() {
      if (!isWeb || compact || !hasPrecisePointer()) {
        return undefined;
      }
      return autofocusInput(domInputNode(startInPrompt ? promptRef.current : searchRef.current));
    },
    [isWeb, compact, startInPrompt],
  );

  function scrollToRow(id: string | null): void {
    const index = hits.findIndex(function match(hit) {
      return hit.id === id;
    });
    if (index >= 0) {
      listRef.current?.scrollTo({ y: Math.max(0, (index - 2) * ROW_HEIGHT), animated: false });
    }
  }

  function onQueryChange(text: string): void {
    setQuery(text);
    // A new filter starts from its best hit.
    setPicked({ id: null });
    listRef.current?.scrollTo({ y: 0, animated: false });
  }

  // ---- agent configuration
  const [choice, setChoice] = useState<LaunchChoice | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const initializedRef = useRef(false);
  const providerList = providers.status === "ready" ? providers.value : null;
  useEffect(
    function initialize() {
      if (initializedRef.current || providerList === null || profiles === null || settingsLoading) {
        return;
      }
      initializedRef.current = true;
      const initial = initialChoice(providerList, profiles, settingsValues);
      setChoice(initial.choice);
      setProfileId(initial.profileId);
    },
    [providerList, profiles, settingsLoading, settingsValues],
  );
  const provider =
    choice === null
      ? null
      : (providerList?.find(function match(entry) {
          return entry.id === choice.provider;
        }) ?? null);

  // Providers whose snapshot carried no models load their catalog on demand.
  const providerId = provider?.id ?? null;
  const needsCatalog = provider !== null && provider.models === null;
  useEffect(
    function loadCatalog() {
      if (providerId === null || !needsCatalog) {
        return;
      }
      void modelCatalogFor(paseo, providerId).then(function apply(models) {
        if (!aliveRef.current || models === null || models.length === 0) {
          return;
        }
        setProviders(function patch(current) {
          if (current.status !== "ready") {
            return current;
          }
          return {
            status: "ready",
            value: current.value.map(function withModels(entry) {
              return entry.id === providerId ? { ...entry, models } : entry;
            }),
          };
        });
        setChoice(function refine(current) {
          if (current === null || current.provider !== providerId) {
            return current;
          }
          const loaded = { ...(provider as LaunchProvider), models };
          return resolveChoice(loaded, current);
        });
      });
    },
    [paseo, providerId, needsCatalog],
  );

  const profile =
    profileId === null
      ? null
      : (profiles?.find(function match(entry) {
          return entry.id === profileId;
        }) ?? null);
  // A profile stays lit only while the choice still carries what it sets.
  const activeProfile = profile !== null && choice !== null && profileMatches(profile, choice) ? profile : null;

  function pickProvider(next: LaunchProvider): void {
    setChoice(resolveChoice(next, settingsValues.byProvider[next.id]));
    setProfileId(null);
  }

  function pickProfile(next: LaunchProfile): void {
    const target = providerList?.find(function match(entry) {
      return entry.id === next.provider;
    });
    if (target === undefined) {
      return;
    }
    setChoice(choiceFromProfile(next, target));
    setProfileId(next.id);
  }

  // ---- message and create
  const [prompt, setPrompt] = useState(promptDraft);
  const [creating, setCreating] = useState(false);
  // State lags a fast double Enter; the ref does not.
  const creatingRef = useRef(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [panel, setPanel] = useState<"form" | "model">("form");
  const submitOnEnter = isWeb && !compact;
  const canCreate = workspace !== null && choice !== null && prompt.trim() !== "" && !creating;

  function onPromptChange(text: string): void {
    promptDraft = text;
    setPrompt(text);
    setCreateError(null);
  }

  async function create(): Promise<void> {
    if (workspace === null || choice === null || prompt.trim() === "" || creatingRef.current) {
      return;
    }
    const descriptor = descriptorsRef.current.get(workspace.id);
    if (descriptor === undefined) {
      return;
    }
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const handle = await paseo.workspaces.ref(descriptor).agents.create({
        config: launchConfig(choice, activeProfile),
        prompt: prompt.trim(),
      });
      promptDraft = "";
      if (settings.status === "ready") {
        void settings.save(
          rememberLaunch(settings.values, workspace.id, choice, activeProfile?.id ?? null),
          settings.revision,
        );
      }
      props.onCreated(handle.id);
    } catch (error) {
      creatingRef.current = false;
      if (aliveRef.current) {
        setCreateError(`创建失败：${errorText(error)}`);
        setCreating(false);
      }
    }
  }

  function onSearchKey(event: KeyPressEvent): void {
    const native = event.nativeEvent;
    if (isImeComposing(native)) {
      return;
    }
    if (native.key === "ArrowDown" || native.key === "ArrowUp") {
      native.preventDefault?.();
      const next = moveSelection(hits, workspaceId, native.key === "ArrowDown" ? 1 : -1);
      setPicked({ id: next });
      scrollToRow(next);
    } else if (native.key === "Enter") {
      native.preventDefault?.();
      if (workspace !== null) {
        focusPrompt();
      }
    } else if (native.key === "Escape") {
      native.preventDefault?.();
      if (query !== "") {
        onQueryChange("");
      } else {
        props.onClose();
      }
    }
  }

  function onPromptKey(event: KeyPressEvent): void {
    const native = event.nativeEvent;
    if (isImeComposing(native)) {
      return;
    }
    if (native.key === "Escape") {
      native.preventDefault?.();
      props.onClose();
    } else if (native.key === "Enter" && submitOnEnter && native.shiftKey !== true) {
      native.preventDefault?.();
      void create();
    }
  }

  const separator = withAlpha(colors.foregroundMuted, "33", colors.border);
  const inputStyle = {
    color: colors.foreground,
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: separator,
    backgroundColor: colors.surface1,
    outlineWidth: 0,
  } as const;

  let workspaceList;
  if (workspaces.status === "loading") {
    workspaceList = (
      <View style={{ height: ROW_HEIGHT * 2, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  } else if (workspaces.status === "error") {
    workspaceList = (
      <View style={{ paddingVertical: 12, gap: 8, alignItems: "flex-start" }}>
        <Text style={{ color: colors.statusDanger, fontSize: 12 }}>
          {`工作区加载失败：${workspaces.error}`}
        </Text>
        <Chip theme={theme} label="重试" selected={false} onPress={retry} />
      </View>
    );
  } else if (hits.length === 0) {
    workspaceList = (
      <View style={{ height: ROW_HEIGHT, justifyContent: "center", paddingHorizontal: 10 }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
          {workspaces.value.length === 0 ? "Paseo 中还没有工作区" : "没有匹配的工作区"}
        </Text>
      </View>
    );
  } else {
    workspaceList = (
      <ScrollView
        ref={listRef}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        style={{
          maxHeight: ROW_HEIGHT * (compact ? 4.5 : 6.5),
          borderRadius: 8,
          borderWidth: 1,
          borderColor: separator,
        }}
      >
        {hits.map(function renderRow(hit) {
          const active = hit.id === workspaceId;
          const heading = workspaceHeading(hit);
          return (
            <Pressable
              key={hit.id}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={function choose() {
                setPicked({ id: hit.id });
                focusPrompt();
              }}
              style={function rowStyle(state) {
                const hovered = (state as { hovered?: boolean }).hovered === true;
                return {
                  height: ROW_HEIGHT,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  paddingHorizontal: 10,
                  backgroundColor: active
                    ? withAlpha(colors.accent, "26", colors.surface2)
                    : hovered
                      ? colors.surface1
                      : "transparent",
                };
              }}
            >
              <Icon
                name={hit.worktree ? "GitBranch" : "Folder"}
                size={15}
                color={active ? colors.accent : colors.foregroundMuted}
              />
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13 }}>
                  <Text style={{ fontWeight: "600" }}>{heading.main}</Text>
                  {heading.extra === null ? null : (
                    <Text style={{ color: colors.foregroundMuted }}>{`  ${heading.extra}`}</Text>
                  )}
                </Text>
                <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                  {workspaceSubtitle(hit)}
                </Text>
              </View>
              {active ? <Icon name="Check" size={14} color={colors.accent} /> : null}
            </Pressable>
          );
        })}
      </ScrollView>
    );
  }

  const model = provider === null || choice === null ? null : findModel(provider, choice.model);
  const thinkingOptions = model?.thinkingOptions ?? [];

  let agentSection;
  if (providers.status === "loading" || (providers.status === "ready" && profiles === null) || settingsLoading) {
    agentSection = (
      <View style={{ paddingVertical: 12, alignItems: "flex-start" }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  } else if (providers.status === "error") {
    agentSection = (
      <View style={{ gap: 8, alignItems: "flex-start" }}>
        <Text style={{ color: colors.statusDanger, fontSize: 12 }}>
          {`Agent 列表加载失败：${providers.error}`}
        </Text>
        <Chip theme={theme} label="重试" selected={false} onPress={retry} />
      </View>
    );
  } else if (providers.value.length === 0 || choice === null || provider === null) {
    agentSection = (
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>没有可用的 Agent</Text>
    );
  } else {
    const current = choice;
    const currentProvider = provider;
    agentSection = (
      <View style={{ gap: 10 }}>
        {profiles !== null && profiles.length > 0 ? (
          <FieldRow theme={theme} compact={compact} label="预设">
            {profiles.map(function renderProfile(entry) {
              const available = providers.value.some(function match(candidate) {
                return candidate.id === entry.provider;
              });
              return (
                <Chip
                  key={entry.id}
                  theme={theme}
                  label={entry.name}
                  selected={activeProfile?.id === entry.id}
                  disabled={!available}
                  onPress={function choose() {
                    pickProfile(entry);
                  }}
                />
              );
            })}
          </FieldRow>
        ) : null}
        <FieldRow theme={theme} compact={compact} label="Agent">
          {providers.value.map(function renderProvider(entry) {
            return (
              <Chip
                key={entry.id}
                theme={theme}
                label={entry.label}
                selected={entry.id === current.provider}
                onPress={function choose() {
                  if (entry.id !== current.provider) {
                    pickProvider(entry);
                  }
                }}
              />
            );
          })}
        </FieldRow>
        <FieldRow theme={theme} compact={compact} label="模型">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="选择模型"
            onPress={function openModels() {
              setPanel("model");
            }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingHorizontal: 10,
              paddingVertical: 5,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surface1,
            }}
          >
            <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 12, maxWidth: 320 }}>
              {model?.label ?? (current.model === "" ? "默认模型" : current.model)}
            </Text>
            {currentProvider.models === null ? (
              <ActivityIndicator size={10} color={colors.foregroundMuted} />
            ) : (
              <Icon name="ChevronDown" size={12} color={colors.foregroundMuted} />
            )}
          </Pressable>
        </FieldRow>
        {thinkingOptions.length > 0 ? (
          <FieldRow theme={theme} compact={compact} label="思考">
            {thinkingOptions.map(function renderThinking(option) {
              return (
                <Chip
                  key={option.id}
                  theme={theme}
                  label={option.label}
                  selected={option.id === current.thinkingOptionId}
                  onPress={function choose() {
                    setChoice({ ...current, thinkingOptionId: option.id });
                  }}
                />
              );
            })}
          </FieldRow>
        ) : null}
        {currentProvider.modes.length > 0 ? (
          <FieldRow theme={theme} compact={compact} label="权限">
            {currentProvider.modes.map(function renderMode(mode) {
              return (
                <Chip
                  key={mode.id}
                  theme={theme}
                  label={mode.label}
                  tone={mode.colorTier === "dangerous" ? colors.statusDanger : undefined}
                  selected={mode.id === current.modeId}
                  onPress={function choose() {
                    setChoice({ ...current, modeId: mode.id });
                  }}
                />
              );
            })}
          </FieldRow>
        ) : null}
      </View>
    );
  }

  const form = (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      // Full-screen on phones: fill the height so the buttons sit at the bottom.
      style={{ flexGrow: compact ? 1 : 0, flexShrink: 1 }}
      contentContainerStyle={{ padding: 14, gap: 14 }}
    >
      <View style={{ gap: 8 }}>
        <SectionLabel theme={theme} label="工作区" />
        <TextInput
          ref={searchRef}
          value={query}
          onChangeText={onQueryChange}
          onKeyPress={onSearchKey}
          // Native single-line inputs report Enter only here; web uses onKeyPress.
          onSubmitEditing={isWeb ? undefined : focusPrompt}
          submitBehavior={isWeb ? undefined : "submit"}
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
          placeholder="输入项目名、工作区、分支或路径过滤，↑↓ 选择，Enter 确认"
          placeholderTextColor={colors.foregroundMuted}
          style={inputStyle}
        />
        {workspaceList}
      </View>
      {agentSection}
      <View style={{ gap: 8 }}>
        <SectionLabel theme={theme} label="第一条消息" />
        <TextInput
          ref={promptRef}
          value={prompt}
          onChangeText={onPromptChange}
          onKeyPress={onPromptKey}
          multiline
          autoCorrect={false}
          placeholder={submitOnEnter ? "要做什么？Enter 创建，Shift+Enter 换行" : "要做什么？"}
          placeholderTextColor={colors.foregroundMuted}
          style={[inputStyle, { minHeight: compact ? 96 : 120, textAlignVertical: "top" }]}
        />
      </View>
    </ScrollView>
  );

  const footer = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderTopWidth: 1,
        borderTopColor: colors.border,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        {createError !== null ? (
          <Text numberOfLines={2} style={{ color: colors.statusDanger, fontSize: 12 }}>
            {createError}
          </Text>
        ) : workspace !== null ? (
          <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 12 }}>
            {`在「${workspaceLabel(workspace)}」中创建`}
          </Text>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={props.onClose}
        style={{
          paddingHorizontal: 14,
          paddingVertical: 7,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: separator,
          backgroundColor: colors.surface1,
        }}
      >
        <Text style={{ color: colors.foreground, fontSize: 13 }}>取消</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !canCreate }}
        disabled={!canCreate}
        onPress={function submit() {
          void create();
        }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 14,
          paddingVertical: 7,
          borderRadius: 8,
          backgroundColor: colors.accent,
          opacity: canCreate ? 1 : 0.5,
        }}
      >
        {creating ? <ActivityIndicator size={12} color={colors.accentForeground} /> : null}
        <Text style={{ color: colors.accentForeground, fontSize: 13, fontWeight: "600" }}>
          {creating ? "创建中…" : "创建"}
        </Text>
      </Pressable>
    </View>
  );

  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 2100,
        elevation: 26,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="关闭新建会话"
        onPress={props.onClose}
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
          width: compact ? "100%" : "94%",
          maxWidth: compact ? undefined : 760,
          height: compact ? "100%" : undefined,
          maxHeight: compact ? undefined : "92%",
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
          {panel === "model" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="返回"
              hitSlop={8}
              onPress={function back() {
                setPanel("form");
              }}
              style={{ padding: 4 }}
            >
              <Icon name="ChevronLeft" size={18} color={colors.foregroundMuted} />
            </Pressable>
          ) : null}
          <Text style={{ flex: 1, color: colors.foreground, fontSize: 15, fontWeight: "700" }}>
            {panel === "model" ? `选择模型 · ${provider?.label ?? ""}` : "新建会话"}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭"
            hitSlop={8}
            onPress={props.onClose}
            style={{ padding: 6 }}
          >
            <Icon name="X" size={18} color={colors.foregroundMuted} />
          </Pressable>
        </View>
        {panel === "model" && provider !== null && choice !== null ? (
          <ModelPanel
            theme={theme}
            compact={compact}
            models={provider.models ?? []}
            loading={provider.models === null}
            currentId={choice.model}
            onPick={function pick(id) {
              setChoice(withModel(provider, choice, id));
              setPanel("form");
            }}
            onBack={function back() {
              setPanel("form");
            }}
          />
        ) : (
          <>
            {form}
            {footer}
          </>
        )}
      </View>
    </View>
  );
}

function SectionLabel(props: { theme: PluginTheme; label: string }) {
  return (
    <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>
      {props.label}
    </Text>
  );
}

/** A label with wrapping chips: side by side when wide, stacked when compact. */
function FieldRow(props: {
  theme: PluginTheme;
  compact: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <View
      style={{
        flexDirection: props.compact ? "column" : "row",
        alignItems: props.compact ? "stretch" : "flex-start",
        gap: props.compact ? 6 : 10,
      }}
    >
      <View style={{ width: props.compact ? undefined : 44, paddingTop: props.compact ? 0 : 6 }}>
        <SectionLabel theme={props.theme} label={props.label} />
      </View>
      <View style={{ flex: props.compact ? undefined : 1, flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {props.children}
      </View>
    </View>
  );
}

/** Searchable model list; Enter takes the top match, Esc goes back. */
function ModelPanel(props: {
  theme: PluginTheme;
  compact: boolean;
  models: readonly LaunchModel[];
  loading: boolean;
  currentId: string;
  onPick(id: string): void;
  onBack(): void;
}) {
  const { colors } = props.theme;
  const [query, setQuery] = useState("");
  const inputRef = useRef<TextInputHandle | null>(null);
  useEffect(
    function autofocus() {
      if (Platform.OS !== "web" || props.compact || !hasPrecisePointer()) {
        return undefined;
      }
      return autofocusInput(domInputNode(inputRef.current));
    },
    [props.compact],
  );
  const results = useMemo(
    function filter() {
      const selectable = props.models.filter(function selectable(model) {
        return model.isSelectable !== false;
      });
      return searchEntries(
        selectable.map(function toEntry(model) {
          return { id: model.id, label: model.label, provider: model.description ?? "", model };
        }),
        query,
      );
    },
    [props.models, query],
  );

  function onKey(event: KeyPressEvent): void {
    const native = event.nativeEvent;
    if (isImeComposing(native)) {
      return;
    }
    if (native.key === "Enter") {
      native.preventDefault?.();
      const top = results[0];
      if (top !== undefined) {
        props.onPick(top.id);
      }
    } else if (native.key === "Escape") {
      native.preventDefault?.();
      props.onBack();
    }
  }

  return (
    <View style={{ flexShrink: 1, padding: 14, gap: 10, minHeight: props.compact ? undefined : 360 }}>
      <TextInput
        ref={inputRef}
        value={query}
        onChangeText={setQuery}
        onKeyPress={onKey}
        autoCorrect={false}
        autoCapitalize="none"
        spellCheck={false}
        placeholder="搜索模型"
        placeholderTextColor={colors.foregroundMuted}
        style={{
          color: colors.foreground,
          fontSize: 13,
          paddingHorizontal: 10,
          paddingVertical: 8,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: withAlpha(colors.foregroundMuted, "33", colors.border),
          backgroundColor: colors.surface1,
          outlineWidth: 0,
        }}
      />
      {props.loading ? (
        <ActivityIndicator color={colors.accent} />
      ) : (
        <ScrollView keyboardShouldPersistTaps="handled" style={{ flexShrink: 1 }}>
          {results.length === 0 ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 12, padding: 10 }}>
              没有匹配的模型
            </Text>
          ) : null}
          {results.map(function renderModel(entry) {
            const active = entry.id === props.currentId;
            return (
              <Pressable
                key={entry.id}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={function choose() {
                  props.onPick(entry.id);
                }}
                style={function rowStyle(state) {
                  const hovered = (state as { hovered?: boolean }).hovered === true;
                  return {
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    paddingHorizontal: 10,
                    paddingVertical: 8,
                    borderRadius: 8,
                    backgroundColor: active
                      ? withAlpha(colors.accent, "26", colors.surface2)
                      : hovered
                        ? colors.surface1
                        : "transparent",
                  };
                }}
              >
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13 }}>
                    {entry.label}
                  </Text>
                  <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                    {entry.model.description ? `${entry.id} · ${entry.model.description}` : entry.id}
                  </Text>
                </View>
                {active ? <Icon name="Check" size={14} color={colors.accent} /> : null}
              </Pressable>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}
