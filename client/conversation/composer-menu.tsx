/**
 * Popup menu anchored to a composer button: opens upward inside the frame,
 * surface2 card, closes on outside click (full-screen transparent backdrop)
 * or after a selection. Rendered inside a `position:"relative"` anchor View.
 */
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import type { ComposerPalette } from "./composer-tokens";

export type ComposerMenuItem = {
  id: string;
  label: string;
  icon?: string;
  description?: string;
  selected?: boolean;
  disabled?: boolean;
};

export function ComposerMenu(props: {
  palette: ComposerPalette;
  items: readonly ComposerMenuItem[];
  onSelect(id: string): void;
  onClose(): void;
  align?: "left" | "right";
}) {
  const { palette } = props;
  const alignRight = props.align === "right";
  return (
    <>
      <Pressable
        accessibilityLabel="关闭菜单"
        onPress={props.onClose}
        style={{
          position: "absolute",
          top: -4000,
          bottom: -4000,
          left: -4000,
          right: -4000,
          zIndex: 40,
        }}
      />
      <View
        style={{
          position: "absolute",
          bottom: "100%",
          marginBottom: 8,
          left: alignRight ? undefined : 0,
          right: alignRight ? 0 : undefined,
          minWidth: 220,
          backgroundColor: palette.surface2,
          borderWidth: 1,
          borderColor: palette.border,
          borderRadius: 8,
          padding: 4,
          gap: 2,
          zIndex: 50,
        }}
      >
        {props.items.map(function renderItem(item) {
          return (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              disabled={item.disabled === true}
              onPress={function choose() {
                props.onSelect(item.id);
                props.onClose();
              }}
              style={function itemStyle(state) {
                return {
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  paddingHorizontal: 8,
                  paddingVertical: 6,
                  borderRadius: 6,
                  backgroundColor:
                    (state as { hovered?: boolean }).hovered === true
                      ? palette.surface1
                      : "transparent",
                  opacity: item.disabled === true ? 0.5 : 1,
                };
              }}
            >
              {item.icon !== undefined ? (
                <Icon name={item.icon} size={14} color={palette.foregroundMuted} />
              ) : null}
              <View style={{ flex: 1, gap: 1 }}>
                <Text style={{ color: palette.foreground, fontSize: 13 }}>{item.label}</Text>
                {item.description !== undefined && item.description !== "" ? (
                  <Text style={{ color: palette.foregroundMuted, fontSize: 11 }}>
                    {item.description}
                  </Text>
                ) : null}
              </View>
              {item.selected === true ? (
                <Icon name="Check" size={14} color={palette.accent} />
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </>
  );
}
