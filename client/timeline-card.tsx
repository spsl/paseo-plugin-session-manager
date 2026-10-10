/**
 * The card in an agent's transcript: header 「会话看板 · <状态>」 with a play
 * button, the italic sentence, and the next step (or the request details for a
 * permission card). Written by the daemon (`server/cards.ts`); this only draws
 * it. The host validates `data` against SessionCardSchema before rendering.
 *
 * Async function expressions only (Hermes).
 */
import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { CardTone, SessionCard } from "../shared/card";
import { getAnnouncer } from "./announcer";
import { withAlpha } from "./styles";

function toneColor(theme: PluginTheme, tone: CardTone): string {
  const { colors } = theme;
  switch (tone) {
    case "success":
      return colors.statusSuccess;
    case "warning":
      return colors.statusWarning;
    case "danger":
      return colors.statusDanger;
    case "info":
      return colors.accent;
    case "muted":
      return colors.foregroundMuted;
  }
}

export function SessionTimelineCard({ theme, layout, item }: PluginTimelineItemProps<SessionCard>) {
  const card = item.data;
  const toast = useToast();
  const [speaking, setSpeaking] = useState(false);
  const muted = card.state === "superseded" || card.state === "resolved";
  const tone = toneColor(theme, card.tone);

  const styles = useMemo(() => {
    const { colors } = theme;
    return {
      card: {
        borderWidth: 1,
        borderColor: muted ? colors.border : withAlpha(tone, "66", colors.border),
        borderRadius: 10,
        backgroundColor: colors.surface1,
        paddingHorizontal: layout.compact ? 10 : 12,
        paddingVertical: layout.compact ? 8 : 10,
        gap: 6,
        opacity: muted ? 0.65 : 1,
      },
      header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      brand: { color: colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const },
      label: { color: tone, fontSize: 12, fontWeight: "600" as const, flexShrink: 1 },
      spacer: { flex: 1 },
      play: { padding: 4 },
      playDisabled: { opacity: 0.4 },
      text: {
        color: muted ? colors.foregroundMuted : colors.foreground,
        fontSize: layout.compact ? 15 : 14,
        lineHeight: layout.compact ? 21 : 20,
        fontStyle: "italic" as const,
      },
      title: {
        color: colors.foreground,
        fontSize: layout.compact ? 15 : 14,
        lineHeight: layout.compact ? 21 : 20,
        fontWeight: "600" as const,
      },
      pending: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      pendingText: { color: colors.foregroundMuted, fontSize: 13 },
      note: { color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
      choices: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      choice: {
        color: colors.foreground,
        fontSize: 12,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 2,
        backgroundColor: colors.surface2,
        overflow: "hidden" as const,
      },
    };
  }, [theme, layout.compact, muted, tone]);

  const speak = card.speak;
  const play = useCallback(
    async function play() {
      const announcer = getAnnouncer();
      if (announcer === null || speak === null) {
        return;
      }
      setSpeaking(true);
      try {
        // Pressed on purpose, so the on/off switches do not apply.
        const blocked = await announcer.speakText(speak, { force: true });
        if (blocked !== null) {
          toast.show(blocked, { variant: "info" });
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setSpeaking(false);
      }
    },
    [speak, toast],
  );

  const isPermission = card.variant === "permission";
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Icon name="Kanban" size={14} color={theme.colors.foregroundMuted} />
        <Text style={styles.brand}>会话看板</Text>
        <Text style={styles.label} numberOfLines={1}>{`· ${card.label}`}</Text>
        {speak !== null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={speaking ? "正在播放" : "朗读这段总结"}
            hitSlop={8}
            disabled={speaking}
            onPress={function onPress() {
              void play();
            }}
            style={[styles.play, speaking ? styles.playDisabled : null]}
          >
            <Icon name={speaking ? "Volume2" : "Play"} size={14} color={theme.colors.foreground} />
          </Pressable>
        ) : null}
        <View style={styles.spacer} />
      </View>
      {card.state === "pending" ? (
        <View style={styles.pending}>
          <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
          <Text style={styles.pendingText}>{card.text ?? "正在分析…"}</Text>
        </View>
      ) : card.text !== null ? (
        <Text style={isPermission ? styles.title : styles.text}>{card.text}</Text>
      ) : null}
      {card.detail !== null ? (
        <Text style={styles.note} numberOfLines={6}>
          {card.detail}
        </Text>
      ) : null}
      {card.choices.length > 0 ? (
        <View style={styles.choices}>
          {card.choices.map(function renderChoice(choice, index) {
            return (
              <Text key={`${index}:${choice}`} style={styles.choice}>
                {choice}
              </Text>
            );
          })}
        </View>
      ) : null}
      {card.nextStep !== null ? <Text style={styles.note}>{`下一步：${card.nextStep}`}</Text> : null}
    </View>
  );
}
