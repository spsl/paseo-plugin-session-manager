/** Board header search: filters projects as you type, × clears it. */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

export function ProjectSearch(props: {
  theme: PluginTheme;
  value: string;
  onChange(value: string): void;
}) {
  const { colors } = props.theme;
  const [focused, setFocused] = useState(false);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: focused ? colors.accent : colors.border,
        backgroundColor: colors.surface1,
      }}
    >
      <Icon name="Search" size={14} color={colors.foregroundMuted} />
      <TextInput
        value={props.value}
        onChangeText={props.onChange}
        onFocus={function focus() {
          setFocused(true);
        }}
        onBlur={function blur() {
          setFocused(false);
        }}
        autoCorrect={false}
        autoCapitalize="none"
        spellCheck={false}
        placeholder="搜索项目名称"
        placeholderTextColor={colors.foregroundMuted}
        style={{
          flex: 1,
          minWidth: 0,
          color: colors.foreground,
          fontSize: 13,
          paddingVertical: 7,
          // The rounded container shows focus; drop the input's square ring.
          outlineWidth: 0,
        }}
      />
      {props.value === "" ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="清空搜索"
          hitSlop={8}
          onPress={function clear() {
            props.onChange("");
          }}
        >
          <Icon name="X" size={14} color={colors.foregroundMuted} />
        </Pressable>
      )}
    </View>
  );
}
