/**
 * Edit-then-send dialog for a review request. The rendered template is fetched
 * from the server on open; 发送 hands the edited text to review.request.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { reviewPreviewRpc } from "../shared/rpc";
import { withAlpha } from "./styles";
import { useSessionActions } from "./use-snapshot";

type Props = {
  sessionId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  theme: PluginTheme;
  compact: boolean;
};

export function ReviewRequestDialog(props: Props) {
  const { theme, compact, sessionId, open } = props;
  const { colors } = theme;
  const preview = useRpc(reviewPreviewRpc);
  const actions = useSessionActions();
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const separator = withAlpha(colors.foregroundMuted, "33", colors.border);
  const button = {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: separator,
    backgroundColor: colors.surface1,
  };

  useEffect(
    function loadPreview() {
      if (!open) {
        return;
      }
      let cancelled = false;
      setLoading(true);
      setProblem(null);
      setDraft("");
      preview({ sessionId })
        .then(function done(result) {
          if (cancelled) return;
          setDraft(result.text);
        })
        .catch(function failed(error) {
          if (cancelled) return;
          setProblem(error instanceof Error ? error.message : String(error));
        })
        .finally(function settled() {
          if (cancelled) return;
          setLoading(false);
        });
      return function cancel() {
        cancelled = true;
      };
    },
    [open, sessionId, preview],
  );

  async function send(): Promise<void> {
    setSending(true);
    try {
      const ok = await actions.requestReview(sessionId, draft);
      if (ok) {
        props.onOpenChange(false);
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal title="发起代码审查" open={open} onOpenChange={props.onOpenChange}>
      <Modal.Content
        scrollable={false}
        style={{ flex: 1 }}
        contentContainerStyle={{ flex: 1, padding: compact ? 12 : 16, gap: 10 }}
      >
        {loading ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>正在生成请求文本…</Text>
        ) : null}
        {problem !== null ? (
          <Text style={{ color: colors.statusDanger, fontSize: 13 }}>
            {`预览失败：${problem}`}
          </Text>
        ) : null}
        <TextInput
          value={draft}
          onChangeText={setDraft}
          multiline
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
          editable={!loading && !sending}
          placeholder="留空使用服务端生成的默认请求。"
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
          发送后这段话会追加到该会话；由它自己创建审查子 Agent 并复核。
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flex: 1 }} />
          <Pressable
            accessibilityRole="button"
            onPress={function cancel() {
              props.onOpenChange(false);
            }}
            style={button}
          >
            <Text style={{ color: colors.foreground, fontSize: 13 }}>取消</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={loading || sending}
            onPress={function press() {
              void send();
            }}
            style={[
              button,
              {
                backgroundColor: colors.accent,
                borderColor: colors.accent,
                opacity: loading || sending ? 0.5 : 1,
              },
            ]}
          >
            <Text style={{ color: colors.accentForeground, fontSize: 13, fontWeight: "600" }}>
              {sending ? "发送中…" : "发送"}
            </Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
}
