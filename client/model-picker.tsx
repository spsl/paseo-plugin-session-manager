/**
 * A settings row that opens the model catalog in a host Modal with a search box.
 * The host `SettingsSelect` cannot search and clips long lists, and Magpie and
 * Pi both expose dozens of models, so this row replaces it whenever a catalog is
 * live. Codex and Claude keep the plain select.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { SettingsRow } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { searchEntries } from "../shared/model-search";
import { withAlpha } from "./styles";

/** A row as the picker needs it: a readable label and the id it selects. */
export type ModelOption = { label: string; value: string };

type Props = {
  label: string;
  hint?: string;
  /** Current value; shown as the row's value even when absent from `options`. */
  value: string;
  options: readonly ModelOption[];
  disabled?: boolean;
  placeholder?: string;
  theme: PluginTheme;
  compact: boolean;
  onSelect(id: string): void;
};

const ROW_HEIGHT = 44;

export function ModelPicker(props: Props) {
  const { theme, compact } = props;
  const { colors } = theme;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const separator = withAlpha(colors.foregroundMuted, "33", colors.border);
  const results = useMemo(
    function filter() {
      // The label carries the readable text and the value is the id; both are
      // searched, so `gpt-6` and `gemini` work the same way.
      return searchEntries(
        props.options.map(function toEntry(option) {
          return { id: option.value, label: option.label, provider: option.label };
        }),
        query,
      ).map(function toOption(entry) {
        return { label: entry.label, value: entry.id };
      });
    },
    [props.options, query],
  );
  const selected = props.options.some(function match(option) {
    return option.value === props.value;
  });

  const button = {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: separator,
    backgroundColor: colors.surface1,
  };

  return (
    <>
      <SettingsRow
        label={props.label}
        {...(props.hint === undefined ? {} : { hint: props.hint })}
      >
        <Pressable
          accessibilityRole="button"
          disabled={props.disabled === true}
          onPress={function openPicker() {
            setQuery("");
            setOpen(true);
          }}
          style={[button, { paddingVertical: 6, opacity: props.disabled === true ? 0.5 : 1 }]}
        >
          <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, maxWidth: 260 }}>
            {props.value}
          </Text>
        </Pressable>
      </SettingsRow>
      <Modal title={props.label} open={open} onOpenChange={setOpen}>
        <Modal.Content
          scrollable={false}
          style={{ flex: 1 }}
          contentContainerStyle={{ flex: 1, padding: compact ? 12 : 16, gap: 10 }}
        >
          <TextInput
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            autoCapitalize="none"
            spellCheck={false}
            placeholder={props.placeholder ?? "搜索模型，如 gpt-6、gemini、luna"}
            placeholderTextColor={colors.foregroundMuted}
            style={{
              color: colors.foreground,
              fontSize: 13,
              paddingHorizontal: 12,
              paddingVertical: 10,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: separator,
              backgroundColor: colors.surface1,
            }}
          />
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
            {`${results.length} / ${props.options.length} 个模型`}
          </Text>
          <FlatList
            data={results}
            keyExtractor={function key(item) {
              return item.value;
            }}
            keyboardShouldPersistTaps="handled"
            style={{ flex: 1 }}
            getItemLayout={function layout(_data, index) {
              return { length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index };
            }}
            renderItem={function render({ item }) {
              const isSelected = item.value === props.value;
              return (
                <Pressable
                  accessibilityRole="button"
                  onPress={function choose() {
                    props.onSelect(item.value);
                    setOpen(false);
                  }}
                  style={{
                    height: ROW_HEIGHT,
                    justifyContent: "center",
                    paddingHorizontal: 12,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: isSelected ? colors.accent : "transparent",
                    backgroundColor: isSelected
                      ? withAlpha(colors.accent, "26", colors.surface1)
                      : "transparent",
                  }}
                >
                  <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13 }}>
                    {item.label}
                  </Text>
                </Pressable>
              );
            }}
            ListEmptyComponent={
              <View style={{ paddingVertical: 24, alignItems: "center" }}>
                <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>
                  没有匹配的模型
                </Text>
              </View>
            }
          />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: 12, flex: 1 }}>
              {selected ? `当前：${props.value}` : "当前值不在列表中"}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={function cancel() {
                setOpen(false);
              }}
              style={button}
            >
              <Text style={{ color: colors.foreground, fontSize: 13 }}>取消</Text>
            </Pressable>
          </View>
        </Modal.Content>
      </Modal>
    </>
  );
}
