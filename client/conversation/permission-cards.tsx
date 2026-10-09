/** Pending permission requests shown above the composer. */
import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, Text, View } from "react-native";
import {
  permissionView,
  type PermissionChoice,
  type PermissionRequestLike,
} from "./permissions";

function choiceColors(theme: PluginTheme, choice: PermissionChoice) {
  const { colors } = theme;
  if (choice.variant === "primary") {
    return { background: colors.accent, border: colors.accent, text: colors.accentForeground };
  }
  if (choice.variant === "danger") {
    return { background: colors.surface1, border: colors.statusDanger, text: colors.statusDanger };
  }
  return { background: colors.surface1, border: colors.border, text: colors.foreground };
}

export function PermissionCards(props: {
  theme: PluginTheme;
  requests: readonly PermissionRequestLike[];
  busy: boolean;
  onChoose(requestId: string, choice: PermissionChoice): void;
}) {
  const { colors } = props.theme;
  if (props.requests.length === 0) {
    return null;
  }
  return (
    <View style={{ gap: 8 }}>
      {props.requests.map(function renderRequest(request) {
        const view = permissionView(request);
        return (
          <View
            key={view.id}
            style={{
              gap: 8,
              padding: 10,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: colors.statusWarning,
              backgroundColor: colors.surface1,
            }}
          >
            <Text style={{ color: colors.statusWarning, fontSize: 12, fontWeight: "600" }}>
              {`需要确认：${view.heading}`}
            </Text>
            {view.body !== "" ? (
              <Text
                selectable
                numberOfLines={8}
                style={{ color: colors.foreground, fontSize: 12, lineHeight: 18 }}
              >
                {view.body}
              </Text>
            ) : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {view.choices.map(function renderChoice(choice, index) {
                const tone = choiceColors(props.theme, choice);
                return (
                  <Pressable
                    key={`${choice.actionId ?? choice.behavior}-${index}`}
                    accessibilityRole="button"
                    disabled={props.busy}
                    onPress={function choose() {
                      props.onChoose(view.id, choice);
                    }}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 7,
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor: tone.border,
                      backgroundColor: tone.background,
                      opacity: props.busy ? 0.5 : 1,
                    }}
                  >
                    <Text style={{ color: tone.text, fontSize: 13 }}>{choice.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        );
      })}
    </View>
  );
}
