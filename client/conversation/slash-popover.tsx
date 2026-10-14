/**
 * Slash-command completion popover above the composer frame: one row per
 * command showing `/name argumentHint` with the description below; the
 * highlighted row uses surface2. `entries` arrives already truncated to what
 * the keyboard can reach (SLASH_VISIBLE_LIMIT), so rendering matches
 * navigation exactly.
 */
import { Pressable, ScrollView, Text, View } from "react-native";
import type { SlashCommandEntry } from "./composer-logic";
import type { ComposerPalette } from "./composer-tokens";

export function SlashPopover(props: {
  palette: ComposerPalette;
  entries: readonly SlashCommandEntry[];
  highlight: number;
  onPick(entry: SlashCommandEntry): void;
}) {
  const { palette } = props;
  return (
    <View
      style={{
        position: "absolute",
        bottom: "100%",
        marginBottom: 8,
        left: 0,
        right: 0,
        backgroundColor: palette.surface1,
        borderWidth: 1,
        borderColor: palette.border,
        borderRadius: 8,
        padding: 4,
        overflow: "hidden",
        zIndex: 60,
      }}
    >
      <ScrollView
        style={{ maxHeight: 240 }}
        contentContainerStyle={{ gap: 2 }}
        keyboardShouldPersistTaps="always"
      >
      {props.entries.map(function renderEntry(entry, index) {
        const active = index === props.highlight;
        return (
          <Pressable
            key={entry.name}
            accessibilityRole="button"
            onPress={function pick() {
              props.onPick(entry);
            }}
            style={{
              paddingHorizontal: 8,
              paddingVertical: 6,
              borderRadius: 6,
              backgroundColor: active ? palette.surface2 : "transparent",
            }}
          >
            <Text style={{ color: palette.foreground, fontSize: 13 }}>
              {`/${entry.name}${entry.argumentHint !== "" ? ` ${entry.argumentHint}` : ""}`}
            </Text>
            {entry.description !== "" ? (
              <Text style={{ color: palette.foregroundMuted, fontSize: 11 }}>
                {entry.description}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
      </ScrollView>
    </View>
  );
}
