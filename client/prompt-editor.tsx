/**
 * A settings row that opens the analyzer prompt for editing in a host Modal
 * with a multiline host TextInput. The draft stays local until 保存. An empty
 * prompt means the built-in business prompt is used.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { SettingsRow } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { MAX_SYSTEM_PROMPT_LENGTH } from "../shared/analysis-config";
import { withAlpha } from "./styles";

type Props = {
  label: string;
  hint?: string;
  value: string;
  disabled?: boolean;
  onSave(next: string): void;
  theme: PluginTheme;
  compact: boolean;
};

const PLACEHOLDER =
  "留空使用内置提示词；这里只覆盖业务分析指令，安全、只读和 JSON 输出约束仍会保留。";

export function PromptEditor(props: Props) {
  const { theme, compact, value, onSave } = props;
  const { colors } = theme;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const separator = withAlpha(colors.foregroundMuted, "33", colors.border);
  const button = {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: separator,
    backgroundColor: colors.surface1,
  };
  const customised = value.trim() !== "";

  return (
    <>
      <SettingsRow label={props.label} {...(props.hint === undefined ? {} : { hint: props.hint })}>
        <Pressable
          accessibilityRole="button"
          disabled={props.disabled === true}
          onPress={function openEditor() {
            setDraft(value);
            setOpen(true);
          }}
          style={[button, { paddingVertical: 6, opacity: props.disabled === true ? 0.5 : 1 }]}
        >
          <Text style={{ color: colors.foreground, fontSize: 13 }}>
            {customised ? "已自定义，编辑…" : "使用默认，编辑…"}
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
            value={draft}
            onChangeText={setDraft}
            multiline
            autoCorrect={false}
            autoCapitalize="none"
            spellCheck={false}
            maxLength={MAX_SYSTEM_PROMPT_LENGTH}
            placeholder={PLACEHOLDER}
            placeholderTextColor={colors.foregroundMuted}
            style={{
              flex: 1,
              minHeight: 200,
              color: colors.foreground,
              fontSize: 13,
              lineHeight: 19,
              fontFamily: "monospace",
              textAlignVertical: "top",
              padding: 12,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: separator,
              backgroundColor: colors.surface1,
            }}
          />
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
            自定义内容会用于后续分析；正在执行的分析继续使用启动时的配置。
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Pressable
              accessibilityRole="button"
              onPress={function restore() {
                setDraft("");
              }}
              style={button}
            >
              <Text style={{ color: colors.foreground, fontSize: 13 }}>恢复默认</Text>
            </Pressable>
            <View style={{ flex: 1 }} />
            <Pressable
              accessibilityRole="button"
              onPress={function cancel() {
                setOpen(false);
              }}
              style={button}
            >
              <Text style={{ color: colors.foreground, fontSize: 13 }}>取消</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={function save() {
                onSave(draft.trim());
                setOpen(false);
              }}
              style={[button, { backgroundColor: colors.accent, borderColor: colors.accent }]}
            >
              <Text style={{ color: colors.accentForeground, fontSize: 13, fontWeight: "600" }}>
                保存
              </Text>
            </Pressable>
          </View>
        </Modal.Content>
      </Modal>
    </>
  );
}
