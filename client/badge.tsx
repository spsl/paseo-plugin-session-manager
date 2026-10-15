import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { toneBackground } from "./styles";

export function Badge(props: { theme: PluginTheme; label: string; tone: string }) {
  return (
    <View
      style={{
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 999,
        backgroundColor: toneBackground(props.theme, props.tone),
      }}
    >
      <Text style={{ color: props.tone, fontSize: 11, fontWeight: "600" }}>{props.label}</Text>
    </View>
  );
}

export function Chip(props: {
  theme: PluginTheme;
  label: string;
  selected: boolean;
  tone?: string;
  /** Tints the label without selecting, e.g. a search hit. */
  highlighted?: boolean;
  disabled?: boolean;
  /** A trailing icon button with its own action, separate from pressing the chip. */
  accessory?: { icon: string; label: string; onPress(): void };
  onPress(): void;
}) {
  const { colors } = props.theme;
  const tone = props.tone ?? colors.accent;
  const disabled = props.disabled === true;
  const accessory = props.accessory;
  const frame = {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: props.selected ? tone : colors.border,
    backgroundColor: props.selected ? toneBackground(props.theme, tone) : colors.surface1,
    opacity: disabled ? 0.5 : 1,
  };
  const text = (
    <Text
      style={{
        color: props.selected || props.highlighted === true ? tone : colors.foreground,
        fontSize: 12,
        fontWeight: props.selected ? "600" : "400",
      }}
    >
      {props.label}
    </Text>
  );
  if (accessory === undefined) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: props.selected, disabled }}
        disabled={disabled}
        onPress={props.onPress}
        style={{ paddingHorizontal: 10, paddingVertical: 5, ...frame }}
      >
        {text}
      </Pressable>
    );
  }
  return (
    <View style={{ flexDirection: "row", alignItems: "center", ...frame }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: props.selected, disabled }}
        disabled={disabled}
        onPress={props.onPress}
        style={{ paddingLeft: 10, paddingRight: 4, paddingVertical: 5 }}
      >
        {text}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessory.label}
        disabled={disabled}
        hitSlop={4}
        onPress={accessory.onPress}
        style={{ paddingLeft: 2, paddingRight: 9, paddingVertical: 5 }}
      >
        <Icon name={accessory.icon} size={12} color={colors.foregroundMuted} />
      </Pressable>
    </View>
  );
}
