/** Live conversation of one agent: timeline, pending permissions, composer, stop. */
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { stopAgentRpc } from "../../shared/rpc";
import { errorText } from "../styles";
import { SNAPSHOT_QUERY_KEY } from "../use-snapshot";
import { Composer, type SendMode } from "./composer";
import { isNearBottom } from "./model";
import { PermissionCards } from "./permission-cards";
import { responseFor, visiblePermissions, type PermissionChoice } from "./permissions";
import { RowView } from "./rows";
import { useConversation } from "./use-conversation";

export function ConversationPane(props: { sessionId: string; theme: PluginTheme; live: boolean }) {
  const { sessionId, theme, live } = props;
  const { colors } = theme;
  const toast = useToast();
  const queryClient = useQueryClient();
  const stopCall = useRpc(stopAgentRpc);
  const conversation = useConversation(sessionId);
  const { handle, state, agent } = conversation;

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const [stuck, setStuck] = useState(true);
  const stuckRef = useRef(true);
  const scrollRef = useRef<ScrollView>(null);

  const invalidateBoard = useCallback(
    function invalidate(): Promise<void> {
      return queryClient.invalidateQueries({ queryKey: SNAPSHOT_QUERY_KEY });
    },
    [queryClient],
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
  const running = agent.running;

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
          return <RowView key={row.key} theme={theme} row={row} />;
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
          onSend={function onSend(mode) {
            void send(mode);
          }}
        />
      </View>
    </View>
  );
}
