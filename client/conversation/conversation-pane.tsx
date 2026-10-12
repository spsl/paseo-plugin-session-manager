/** Live conversation of one agent: timeline, pending permissions, composer, stop. */
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { stopAgentRpc } from "../../shared/rpc";
import { errorText } from "../styles";
import { SNAPSHOT_QUERY_KEY } from "../use-snapshot";
import { Composer, type SendMode } from "./composer";
import { useComposerDraft } from "./drafts";
import { isNearBottom } from "./model";
import {
  enqueueMessage,
  popQueuedMessage,
  queueFor,
  removeQueuedMessage,
  useQueuedMessages,
  type QueuedMessage,
} from "./queue";
import { PermissionCards } from "./permission-cards";
import { responseFor, visiblePermissions, type PermissionChoice } from "./permissions";
import { RowView } from "./rows";
import { useConversation } from "./use-conversation";

/** Sessions whose queue is draining; module-level so a reopened pane never sends twice. */
const flushingSessions = new Set<string>();

export function ConversationPane(props: {
  sessionId: string;
  theme: PluginTheme;
  live: boolean;
  compact: boolean;
}) {
  const { sessionId, theme, live, compact } = props;
  const { colors } = theme;
  const toast = useToast();
  const queryClient = useQueryClient();
  const stopCall = useRpc(stopAgentRpc);
  const conversation = useConversation(sessionId);
  const { handle, state, agent } = conversation;

  const { draft, setDraft } = useComposerDraft(sessionId);
  const queued = useQueuedMessages(sessionId);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
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
    },
    [conversation.loading, conversation.error, invalidateBoard],
  );

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

  async function send(mode: SendMode): Promise<void> {
    const text = draft.trim();
    if (text === "" || sending) {
      return;
    }
    if (mode === "queue") {
      enqueueMessage(sessionId, text);
      setDraft("");
      return;
    }
    setSending(true);
    try {
      if (mode === "send") {
        await handle.send(text);
      } else {
        await handle.send(text, { activeTurnBehavior: mode });
      }
      setDraft("");
      jumpToBottom();
      await Promise.all([conversation.refreshAgent(), invalidateBoard()]);
    } catch (error) {
      toast.error(`发送失败：${errorText(error)}`);
    } finally {
      setSending(false);
    }
  }

  // Queued messages go out in order once the agent's turn ends (or is absent).
  const running = agent.running;
  const runningRef = useRef(running);
  runningRef.current = running;
  const refreshRef = useRef(conversation.refreshAgent);
  refreshRef.current = conversation.refreshAgent;
  useEffect(
    function flushQueue() {
      if (running || flushingSessions.has(sessionId) || queueFor(sessionId).length === 0) {
        return;
      }
      flushingSessions.add(sessionId);
      const drain = async function drain(): Promise<void> {
        try {
          for (;;) {
            if (runningRef.current) {
              return;
            }
            const next = queueFor(sessionId)[0];
            if (!next) {
              return;
            }
            await handle.send(next.text);
            removeQueuedMessage(sessionId, next.id);
            if (queueFor(sessionId).length === 0) {
              return;
            }
            // The daemon interrupts a running turn by default, so the next
            // message waits for this one's turn; permission, error or timeout
            // leaves the rest queued until the agent is idle again.
            const finished = await handle.waitForFinish();
            if (finished.status !== "idle") {
              return;
            }
          }
        } catch (error) {
          toast.error(`排队消息发送失败：${errorText(error)}`);
        } finally {
          flushingSessions.delete(sessionId);
          void refreshRef.current();
          void invalidateBoard();
        }
      };
      void drain();
    },
    [running, sessionId, handle, toast, invalidateBoard],
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

  function editQueued(message: QueuedMessage): void {
    const text = popQueuedMessage(sessionId, message.id);
    if (text !== null) {
      setDraft(draft.trim() === "" ? text : `${draft}\n${text}`);
    }
  }

  function dropQueued(message: QueuedMessage): void {
    removeQueuedMessage(sessionId, message.id);
  }

  async function stop(): Promise<void> {
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
      setStopping(false);
    }
  }

  async function choose(requestId: string, choice: PermissionChoice): Promise<void> {
    setAnswering(true);
    setAnswered(function mark(current) {
      return new Set(current).add(requestId);
    });
    try {
      await handle.respondToPermission({ requestId, response: responseFor(choice) });
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

  const pending = visiblePermissions(agent.pending, answered);

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
        {running ? (
          <Pressable
            accessibilityRole="button"
            disabled={stopping}
            onPress={function onStop() {
              void stop();
            }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              paddingHorizontal: 10,
              paddingVertical: 5,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: colors.statusDanger,
              opacity: stopping ? 0.5 : 1,
            }}
          >
            <Icon name="Square" size={12} color={colors.statusDanger} />
            <Text style={{ color: colors.statusDanger, fontSize: 12 }}>
              {stopping ? "停止中…" : "停止"}
            </Text>
          </Pressable>
        ) : null}
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

      <View
        style={{
          gap: 8,
          padding: 12,
          paddingBottom: 12 + keyboardInset,
          borderTopWidth: 1,
          borderTopColor: colors.border,
        }}
      >
        <PermissionCards
          theme={theme}
          requests={pending}
          busy={answering}
          onChoose={function onChoose(requestId, choice) {
            void choose(requestId, choice);
          }}
        />
        <Composer
          theme={theme}
          value={draft}
          onChange={setDraft}
          live={live}
          running={running}
          sending={sending}
          queued={queued}
          onSend={function onSend(mode) {
            void send(mode);
          }}
          onEditQueued={editQueued}
          onRemoveQueued={dropQueued}
        />
      </View>
    </View>
  );
}
