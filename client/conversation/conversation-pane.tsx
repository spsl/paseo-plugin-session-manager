/** Live conversation of one agent: timeline, pending permissions, composer. */
import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  type KeyboardEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import {
  setAgentModeRpc,
  setAgentThinkingRpc,
  stopAgentRpc,
} from "../../shared/rpc";
import type { Liveness } from "../../shared/types";
import { errorText } from "../styles";
import { SNAPSHOT_QUERY_KEY } from "../use-snapshot";
import { Composer } from "./composer";
import type { ComposerImage } from "./composer-images";
import {
  buildSlashEntries,
  createComposerSubmitter,
  resolveActiveSendBehavior,
  resolveThinkingOptionId,
  restoredDraft,
  turnBehaviorFor,
  type SlashCommandEntry,
  type SubmitKind,
} from "./composer-logic";
import { cachedDraft, useComposerDraft } from "./drafts";
import { isNearBottom, steerText } from "./model";
import { modelCatalogFor } from "./model-catalog";
import { readPaseoSendBehavior } from "../paseo-app-settings";
import {
  clearQueue,
  enqueueMessage,
  requeueFront,
  takeQueuedMessage,
  useQueuedMessages,
  type QueuedMessage,
} from "./queue";
import { ensureQueueDrain, markQueuedWhileRunning, nudgeQueueDrain } from "./queue-drain";
import { PermissionCards } from "./permission-cards";
import { visiblePermissions, type PermissionResponseLike } from "./permissions";
import { RowView } from "./rows";
import type { Conversation } from "./use-conversation";

export function ConversationPane(props: {
  sessionId: string;
  /** Owned by the overlay so the overview pane reads the same live state. */
  conversation: Conversation;
  theme: PluginTheme;
  liveness: Liveness;
  compact: boolean;
}) {
  const { sessionId, conversation, theme, liveness, compact } = props;
  const { colors } = theme;
  const toast = useToast();
  const queryClient = useQueryClient();
  const paseo = usePaseo();
  const stopCall = useRpc(stopAgentRpc);
  const setModeCall = useRpc(setAgentModeRpc);
  const setThinkingCall = useRpc(setAgentThinkingRpc);
  const { handle, state, agent } = conversation;

  const { draft, setDraft } = useComposerDraft(sessionId);
  const [images, setImages] = useState<readonly ComposerImage[]>([]);
  const queued = useQueuedMessages(sessionId);
  const [sending, setSending] = useState(false);
  // Synchronous in-flight guard for every send path (state lags a render).
  const sendingRef = useRef(false);
  const [stopping, setStopping] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [modePending, setModePending] = useState(false);
  const [thinkingPending, setThinkingPending] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const [stuck, setStuck] = useState(true);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const stuckRef = useRef(true);
  const scrollRef = useRef<ScrollView>(null);

  const invalidateBoard = useCallback(
    function invalidate(): Promise<void> {
      return queryClient.invalidateQueries({ queryKey: SNAPSHOT_QUERY_KEY });
    },
    [queryClient],
  );

  // The submit pipeline is pure logic + injected effects; its `held` flag is
  // the synchronous double-submit guard (submittingRef semantics).
  const submitter = useMemo(
    function create() {
      return createComposerSubmitter({
        clearInput() {
          setDraft("");
          setImages([]);
        },
        queueMessage(input) {
          enqueueMessage(sessionId, input);
          ensureQueueDrain(paseo);
          markQueuedWhileRunning(sessionId);
        },
        sendMessage(text, options) {
          // Steered turns carry the 追加说明 prefix (same as the board card).
          return handle.send(
            options.activeTurnBehavior === "steer" ? steerText(text) : text,
            options,
          );
        },
        archive() {
          return handle.archive().then(function done() {
            return undefined;
          });
        },
      });
    },
    [handle, paseo, sessionId, setDraft],
  );

  // A successful tail load also resumes a dormant agent daemon-side; one board
  // invalidation flips the card back to live without waiting for the next poll.
  const loadNotified = useRef(false);
  useEffect(
    function notifyLoaded() {
      if (loadNotified.current || conversation.loading || conversation.error !== null) {
        return;
      }
      loadNotified.current = true;
      void invalidateBoard();
      // "synced-idle" trigger: the timeline just loaded; if the agent is idle
      // the drain sends the queue head (its own pre-send recheck applies).
      // Never nudge an archived session — sending would unarchive it.
      if (liveness !== "archived") {
        nudgeQueueDrain(sessionId);
      }
    },
    [conversation.loading, conversation.error, invalidateBoard, sessionId, liveness],
  );

  // The drain observation only runs while a queue is non-empty; opening a
  // pane with an existing queue still has to arm it (e.g. after a reload).
  useEffect(
    function armDrain() {
      ensureQueueDrain(paseo);
    },
    [paseo],
  );

  // Lift the composer by the real keyboard height; on hosts without a
  // software keyboard these events simply never fire.
  useEffect(function watchKeyboard() {
    const showEvent = Platform.OS === "android" ? "keyboardDidShow" : "keyboardWillShow";
    const hideEvent = Platform.OS === "android" ? "keyboardDidHide" : "keyboardWillHide";
    const show = Keyboard.addListener(showEvent, function onShow(event: KeyboardEvent) {
      setKeyboardInset(event.endCoordinates.height);
    });
    const hide = Keyboard.addListener(hideEvent, function onHide() {
      setKeyboardInset(0);
    });
    return function off() {
      show.remove();
      hide.remove();
    };
  }, []);

  function onScroll(event: NativeSyntheticEvent<NativeScrollEvent>): void {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const near = isNearBottom({
      contentHeight: contentSize.height,
      offsetY: contentOffset.y,
      viewportHeight: layoutMeasurement.height,
    });
    if (near !== stuckRef.current) {
      stuckRef.current = near;
      setStuck(near);
    }
  }

  function onContentSizeChange(): void {
    if (stuckRef.current) {
      scrollRef.current?.scrollToEnd({ animated: false });
    }
  }

  function jumpToBottom(): void {
    stuckRef.current = true;
    setStuck(true);
    scrollRef.current?.scrollToEnd({ animated: true });
  }

  async function submit(kind: SubmitKind): Promise<void> {
    if (liveness === "archived" || sendingRef.current) {
      return;
    }
    const failed = { text: draft, images };
    setSendError(null);
    sendingRef.current = true;
    setSending(true);
    try {
      const outcome = await submitter.submit({
        kind,
        running: agent.running,
        hasPendingPermission: agent.pending.length > 0,
        behavior: readPaseoSendBehavior(),
        text: draft,
        images,
      });
      if (outcome === "sent") {
        jumpToBottom();
        await Promise.all([conversation.refreshAgent(), invalidateBoard()]);
      } else if (outcome === "archived") {
        // /exit archived the session; its queue is dead weight now.
        clearQueue(sessionId);
        ensureQueueDrain(paseo);
        await invalidateBoard();
      }
    } catch {
      setDraft(restoredDraft(cachedDraft(sessionId) ?? "", failed.text));
      setImages(function restore(current) {
        return current.length === 0 ? failed.images : [...failed.images, ...current];
      });
      setSendError("发送消息失败");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  function editQueued(message: QueuedMessage): void {
    const taken = takeQueuedMessage(sessionId, message.id);
    if (taken === null) {
      return;
    }
    // Edit replaces the current draft entirely, like Paseo.
    setDraft(taken.text);
    setImages([...taken.images]);
  }

  async function sendQueuedNow(message: QueuedMessage): Promise<void> {
    // A submit is in flight: leave the entry in place and `sending` alone.
    if (sendingRef.current) {
      return;
    }
    const taken = takeQueuedMessage(sessionId, message.id);
    if (taken === null) {
      return;
    }
    setSendError(null);
    sendingRef.current = true;
    setSending(true);
    try {
      const behavior = turnBehaviorFor(
        resolveActiveSendBehavior(readPaseoSendBehavior(), agent.pending.length > 0),
      );
      const outcome = await submitter.sendNow({
        text: taken.text,
        images: taken.images,
        activeTurnBehavior: behavior,
      });
      if (outcome === "none") {
        requeueFront(sessionId, taken);
        return;
      }
      jumpToBottom();
      await Promise.all([conversation.refreshAgent(), invalidateBoard()]);
    } catch {
      requeueFront(sessionId, taken);
      setSendError("发送消息失败");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  // The builtin /exit entry in the popover archives immediately (Paseo's
  // execution:"immediate") instead of rewriting the draft first.
  async function archiveNow(): Promise<void> {
    if (liveness === "archived" || sendingRef.current) {
      return;
    }
    setSendError(null);
    sendingRef.current = true;
    setSending(true);
    try {
      const outcome = await submitter.archiveNow();
      if (outcome === "archived") {
        clearQueue(sessionId);
        ensureQueueDrain(paseo);
        await invalidateBoard();
      }
    } catch {
      setSendError("发送消息失败");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  // Synchronous guard: a second Esc/stop while the RPC is still in flight is
  // dropped (the button is disabled via `stopping`, the keyboard path is not).
  const stoppingRef = useRef(false);
  async function stop(): Promise<void> {
    if (stoppingRef.current) {
      return;
    }
    stoppingRef.current = true;
    setStopping(true);
    try {
      const result = await stopCall({ sessionId });
      if (!result.ok) {
        toast.error(`停止失败：${result.reason ?? "未知原因"}`);
      }
      await Promise.all([conversation.refreshAgent(), invalidateBoard()]);
    } catch (error) {
      toast.error(`停止失败：${errorText(error)}`);
    } finally {
      stoppingRef.current = false;
      setStopping(false);
    }
  }

  async function respond(requestId: string, response: PermissionResponseLike): Promise<void> {
    setAnswering(true);
    setAnswered(function mark(current) {
      return new Set(current).add(requestId);
    });
    try {
      await handle.respondToPermission({ requestId, response });
      await Promise.all([conversation.refreshAgent(), invalidateBoard()]);
    } catch (error) {
      toast.error(`操作失败：${errorText(error)}`);
      setAnswered(function unmark(current) {
        const next = new Set(current);
        next.delete(requestId);
        return next;
      });
    } finally {
      setAnswering(false);
    }
  }

  // Slash commands: fetched lazily the first time the draft has an active
  // "/"; a failed request retries (with a cooldown) on the next slash typing.
  const [slashCommands, setSlashCommands] = useState<readonly SlashCommandEntry[] | null>(null);
  const slashLoaded = useRef(false);
  const slashLastTry = useRef(0);
  const onSlashNeeded = useCallback(
    function onSlashNeeded(): void {
      if (slashLoaded.current || liveness === "archived") {
        return;
      }
      const now = Date.now();
      if (now - slashLastTry.current < 3_000) {
        return;
      }
      slashLastTry.current = now;
      handle
        .commands()
        .then(function loaded(result) {
          const entries = buildSlashEntries(result);
          if (entries === null) {
            return;
          }
          slashLoaded.current = true;
          setSlashCommands(entries);
        })
        .catch(function failed() {
          // Stays unloaded; the next slash keystroke retries after cooldown.
        });
    },
    [handle, liveness],
  );

  // Model label + thinking options come from providers.listModels; the raw
  // model id is shown when the catalog cannot be read.
  const [modelLabel, setModelLabel] = useState<string | null>(null);
  const [thinkingOptions, setThinkingOptions] = useState<
    readonly { id: string; label: string }[] | null
  >(null);
  const [thinkingDefaultId, setThinkingDefaultId] = useState<string | null>(null);
  const provider = agent.provider;
  const model = agent.model;
  useEffect(
    function loadModel() {
      if (provider === null || model === null) {
        setModelLabel(null);
        setThinkingOptions(null);
        setThinkingDefaultId(null);
        return undefined;
      }
      let dead = false;
      void modelCatalogFor(paseo, provider).then(function got(models) {
        if (dead) {
          return;
        }
        const entry =
          models?.find(function byId(candidate) {
            return candidate.id === model;
          }) ?? null;
        setModelLabel(entry?.label ?? model);
        setThinkingOptions(entry?.thinkingOptions ?? null);
        setThinkingDefaultId(entry?.defaultThinkingOptionId ?? null);
      });
      return function drop() {
        dead = true;
      };
    },
    [paseo, provider, model],
  );

  async function selectMode(modeId: string): Promise<void> {
    if (modePending) {
      return;
    }
    setModePending(true);
    try {
      const result = await setModeCall({ sessionId, modeId });
      if (!result.ok) {
        toast.error(`设置模式失败：${result.reason ?? "未知原因"}`);
        return;
      }
      await Promise.all([conversation.refreshAgent(), invalidateBoard()]);
    } catch (error) {
      toast.error(`设置模式失败：${errorText(error)}`);
    } finally {
      setModePending(false);
    }
  }

  async function selectThinking(thinkingOptionId: string): Promise<void> {
    if (thinkingPending) {
      return;
    }
    setThinkingPending(true);
    try {
      const result = await setThinkingCall({ sessionId, thinkingOptionId });
      if (!result.ok) {
        toast.error(`设置思考档位失败：${result.reason ?? "未知原因"}`);
        return;
      }
      await Promise.all([conversation.refreshAgent(), invalidateBoard()]);
    } catch (error) {
      toast.error(`设置思考档位失败：${errorText(error)}`);
    } finally {
      setThinkingPending(false);
    }
  }

  const onAddImages = useCallback(function onAddImages(additions: ComposerImage[]): void {
    setImages(function append(current) {
      return [...current, ...additions];
    });
  }, []);
  const onRemoveImage = useCallback(function onRemoveImage(id: string): void {
    setImages(function remove(current) {
      return current.filter(function keep(image) {
        return image.id !== id;
      });
    });
  }, []);

  const pending = visiblePermissions(agent.pending, answered);
  const running = agent.running;
  // Re-read per render: the composer label and send decisions share the same
  // resolved behavior ("queue" degrades while a permission is pending).
  const sendBehavior = resolveActiveSendBehavior(
    readPaseoSendBehavior(),
    agent.pending.length > 0,
  );

  let content;
  if (conversation.loading) {
    content = (
      <View style={{ padding: 24, alignItems: "center", gap: 8 }}>
        <ActivityIndicator color={colors.accent} />
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>正在加载会话…</Text>
      </View>
    );
  } else {
    content = (
      <>
        {conversation.error ? (
          <View style={{ gap: 6, alignItems: "flex-start" }}>
            <Text style={{ color: colors.statusDanger, fontSize: 12 }}>
              {`加载失败：${conversation.error}`}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={function retry() {
                void conversation.reload();
              }}
            >
              <Text style={{ color: colors.accent, fontSize: 12 }}>重试</Text>
            </Pressable>
          </View>
        ) : null}
        {conversation.hasOlder ? (
          <Pressable
            accessibilityRole="button"
            disabled={conversation.loadingOlder}
            onPress={function older() {
              void conversation.loadOlder();
            }}
            style={{ alignSelf: "center", padding: 6 }}
          >
            <Text style={{ color: colors.accent, fontSize: 12 }}>
              {conversation.loadingOlder ? "加载中…" : "加载更早"}
            </Text>
          </Pressable>
        ) : null}
        {state.rows.length === 0 && !conversation.error ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, textAlign: "center" }}>
            暂无会话内容。
          </Text>
        ) : null}
        {state.rows.map(function renderRow(row) {
          return <RowView key={row.key} theme={theme} row={row} compact={compact} />;
        })}
        {running ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Agent 正在运行…</Text>
          </View>
        ) : null}
      </>
    );
  }

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }}
      >
        <Text style={{ flex: 1, color: colors.foreground, fontSize: 13, fontWeight: "600" }}>
          会话
        </Text>
      </View>

      <View style={{ flex: 1, minHeight: 0 }}>
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 12, gap: 10 }}
          scrollEventThrottle={32}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onScroll={onScroll}
          onContentSizeChange={onContentSizeChange}
        >
          {content}
        </ScrollView>
        {!stuck ? (
          <Pressable
            accessibilityRole="button"
            onPress={jumpToBottom}
            style={{
              position: "absolute",
              right: 16,
              bottom: 12,
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surface2,
            }}
          >
            <Text style={{ color: colors.foreground, fontSize: 12 }}>回到底部</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={{ paddingHorizontal: 16, paddingTop: 0, paddingBottom: 16 + keyboardInset }}>
        <View style={{ width: "100%", maxWidth: 820, alignSelf: "center", gap: 12 }}>
          <PermissionCards
            theme={theme}
            requests={pending}
            busy={answering}
            compact={compact}
            onRespond={function onRespond(requestId, response) {
              void respond(requestId, response);
            }}
          />
          <Composer
            theme={theme}
            liveness={liveness}
            compact={compact}
            value={draft}
            onChange={setDraft}
            images={images}
            onAddImages={onAddImages}
            onRemoveImage={onRemoveImage}
            running={running}
            sending={sending}
            stopping={stopping}
            sendBehavior={sendBehavior}
            sendError={sendError}
            queued={queued}
            onEditQueued={editQueued}
            onSendQueuedNow={function sendNow(message) {
              void sendQueuedNow(message);
            }}
            onSubmit={function onSubmit(kind) {
              void submit(kind);
            }}
            onArchive={function onArchive() {
              void archiveNow();
            }}
            onStop={function onStop() {
              void stop();
            }}
            slashCommands={slashCommands}
            onSlashNeeded={onSlashNeeded}
            modelLabel={modelLabel}
            thinking={
              thinkingOptions !== null && thinkingOptions.length > 0
                ? {
                    options: thinkingOptions,
                    currentId: resolveThinkingOptionId(
                      {
                        effectiveThinkingOptionId: agent.effectiveThinkingOptionId,
                        thinkingOptionId: agent.thinkingOptionId,
                      },
                      thinkingDefaultId,
                      thinkingOptions,
                    ),
                    pending: thinkingPending,
                    onSelect(id) {
                      void selectThinking(id);
                    },
                  }
                : null
            }
            modes={
              agent.modes.length > 0
                ? {
                    list: agent.modes,
                    currentId: agent.currentModeId,
                    pending: modePending,
                    onSelect(id) {
                      void selectMode(id);
                    },
                  }
                : null
            }
            usage={agent.usage}
          />
        </View>
      </View>
    </View>
  );
}
