/** Message composer: idle -> send; running -> interrupt-and-send / steer. */
import type { PluginTheme } from "@getpaseo/plugin";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";

export type SendMode = "send" | "interrupt" | "steer";

function SendButton(props: {
  theme: PluginTheme;
  label: string;
  primary: boolean;
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
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: props.primary ? colors.accent : colors.border,
        backgroundColor: props.primary ? colors.accent : colors.surface1,
        opacity: props.disabled ? 0.5 : 1,
      }}
    >
      <Text style={{ color: props.primary ? colors.accentForeground : colors.foreground, fontSize: 13 }}>
        {props.label}
      </Text>
    </Pressable>
  );
}

export function Composer(props: {
  theme: PluginTheme;
  value: string;
  onChange(value: string): void;
  live: boolean;
  running: boolean;
  sending: boolean;
  onSend(mode: SendMode): void;
}) {
  const { colors } = props.theme;
  const empty = props.value.trim() === "";
  const blocked = !props.live || props.sending || empty;
  return (
    <View style={{ gap: 6 }}>
      {!props.live ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
          会话已关闭或已归档，无法发送消息。
        </Text>
      ) : null}
      <TextInput
        value={props.value}
        onChangeText={props.onChange}
        editable={props.live}
        multiline
        autoCorrect={false}
        placeholder={props.live ? "输入消息发送给 Agent…" : "会话不可用"}
        placeholderTextColor={colors.foregroundMuted}
        style={{
          minHeight: 64,
          maxHeight: 180,
          color: colors.foreground,
          fontSize: 13,
          lineHeight: 19,
          textAlignVertical: "top",
          padding: 10,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface1,
        }}
      />
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
        {props.running ? (
          <>
            <SendButton
              theme={props.theme}
              label="追加到当前轮"
              primary={false}
              disabled={blocked}
              onPress={function steer() {
                props.onSend("steer");
              }}
            />
            <SendButton
              theme={props.theme}
              label="打断并发送"
              primary
              disabled={blocked}
              onPress={function interrupt() {
                props.onSend("interrupt");
              }}
            />
          </>
        ) : (
          <SendButton
            theme={props.theme}
            label={props.sending ? "发送中…" : "发送"}
            primary
            disabled={blocked}
            onPress={function send() {
              props.onSend("send");
            }}
          />
        )}
      </View>
    </View>
  );
}
