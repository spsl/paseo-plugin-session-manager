import type { PluginTheme } from "@getpaseo/plugin";
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
  disabled?: boolean;
  onPress(): void;
}) {
  const { colors } = props.theme;
  const tone = props.tone ?? colors.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected, disabled: props.disabled === true }}
      disabled={props.disabled === true}
      onPress={props.onPress}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: props.selected ? tone : colors.border,
        backgroundColor: props.selected ? toneBackground(props.theme, tone) : colors.surface1,
        opacity: props.disabled === true ? 0.5 : 1,
      }}
    >
      <Text
        style={{
          color: props.selected ? tone : colors.foreground,
          fontSize: 12,
          fontWeight: props.selected ? "600" : "400",
        }}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
