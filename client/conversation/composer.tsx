/**
 * Message composer: idle -> send; running -> queue (primary) plus
 * interrupt / steer as secondary actions. Enter submits, Shift+Enter breaks a
 * line; queued messages sit in a strip above the input until the turn ends.
 * Async function expressions only (Hermes).
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { useRef } from "react";
import type { QueuedMessage } from "./queue";

export type SendMode = "send" | "interrupt" | "steer" | "queue";

type KeyPressEvent = { nativeEvent: { key?: string; shiftKey?: boolean; isComposing?: boolean } };

function SecondaryButton(props: {
  theme: PluginTheme;
  label: string;
  disabled: boolean;
  onPress(): void;
}) {
  const { colors } = props.theme;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
        opacity: props.disabled ? 0.5 : 1,
      }}
    >
      <Text style={{ color: colors.foreground, fontSize: 12 }}>{props.label}</Text>
    </Pressable>
  );
}

function QueueStrip(props: {
  theme: PluginTheme;
  queued: readonly QueuedMessage[];
  onEdit(message: QueuedMessage): void;
  onRemove(message: QueuedMessage): void;
}) {
  const { colors } = props.theme;
  if (props.queued.length === 0) {
    return null;
  }
  return (
    <View
      style={{
        gap: 4,
        padding: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface2,
      }}
    >
      <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
        {`排队中 · ${props.queued.length} 条，本轮结束后自动发送`}
      </Text>
      {props.queued.map(function renderQueued(message) {
        return (
          <View key={message.id} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="编辑这条排队消息"
              onPress={function edit() {
                props.onEdit(message);
              }}
              style={{ flex: 1, minWidth: 0 }}
            >
              <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 12 }}>
                {message.text}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="删除这条排队消息"
              hitSlop={6}
              onPress={function remove() {
                props.onRemove(message);
              }}
            >
              <Icon name="X" size={12} color={colors.foregroundMuted} />
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

export function Composer(props: {
  theme: PluginTheme;
  value: string;
  onChange(value: string): void;
  live: boolean;
  running: boolean;
  sending: boolean;
  queued: readonly QueuedMessage[];
  onSend(mode: SendMode): void;
  onEditQueued(message: QueuedMessage): void;
  onRemoveQueued(message: QueuedMessage): void;
}) {
  const { colors } = props.theme;
  const lastSubmitAt = useRef(0);
  const empty = props.value.trim() === "";
  const blocked = !props.live || props.sending || empty;
  const submitMode: SendMode = props.running ? "queue" : "send";

  function submit(): void {
    if (blocked) {
      return;
    }
    // Web fires both onKeyPress and onSubmitEditing for the same Enter.
    const now = Date.now();
    if (now - lastSubmitAt.current < 300) {
      return;
    }
    lastSubmitAt.current = now;
    props.onSend(submitMode);
  }

  function onKeyPress(event: KeyPressEvent): void {
    const native = event.nativeEvent;
    if (native.key !== "Enter" || native.shiftKey === true || native.isComposing === true) {
      return;
    }
    submit();
  }

  return (
    <View style={{ gap: 8 }}>
      {!props.live ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
          会话已关闭或已归档，无法发送消息。
        </Text>
      ) : null}
      <QueueStrip
        theme={props.theme}
        queued={props.queued}
        onEdit={props.onEditQueued}
        onRemove={props.onRemoveQueued}
      />
      <View
        style={{
          borderRadius: 12,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface1,
          padding: 8,
          gap: 8,
        }}
      >
        <TextInput
          value={props.value}
          onChangeText={props.onChange}
          editable={props.live}
          multiline
          autoCorrect={false}
          returnKeyType="send"
          submitBehavior="submit"
          onSubmitEditing={submit}
          onKeyPress={onKeyPress}
          placeholder={props.live ? "输入消息发送给 Agent…" : "会话不可用"}
          placeholderTextColor={colors.foregroundMuted}
          style={{
            minHeight: 40,
            maxHeight: 180,
            color: colors.foreground,
            fontSize: 13,
            lineHeight: 19,
            textAlignVertical: "top",
            paddingHorizontal: 4,
            paddingVertical: 2,
          }}
        />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flex: 1, flexDirection: "row", gap: 6 }}>
            {props.running ? (
              <>
                <SecondaryButton
                  theme={props.theme}
                  label="打断并发送"
                  disabled={blocked}
                  onPress={function interrupt() {
                    props.onSend("interrupt");
                  }}
                />
                <SecondaryButton
                  theme={props.theme}
                  label="追加到当前轮"
                  disabled={blocked}
                  onPress={function steer() {
                    props.onSend("steer");
                  }}
                />
              </>
            ) : null}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={props.running ? "排队发送" : "发送"}
            disabled={blocked}
            onPress={submit}
            style={{
              width: 30,
              height: 30,
              borderRadius: 999,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: blocked ? colors.surface2 : colors.accent,
            }}
          >
            <Icon
              name={props.running ? "ListEnd" : "ArrowUp"}
              size={15}
              color={blocked ? colors.foregroundMuted : colors.accentForeground}
            />
          </Pressable>
        </View>
      </View>
    </View>
  );
}
