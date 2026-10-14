/**
 * Self-drawn defer menu: fixed duration chips plus a "park in the deferred
 * queue" toggle. Rendered as an absolute overlay; `session` of null hides it.
 * State resets per session via the key prop at the usage site.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  DEFER_CLOCK_TARGETS,
  DEFER_DURATIONS,
  deferClockLabel,
  deferClockTimestamp,
  formatDeferRemaining,
  formatDeferUntil,
  sessionTitle,
} from "../shared/presentation";
import type { SessionView } from "../shared/types";
import { Chip } from "./badge";
import { isDeferred } from "./board-model";
import { useSessionActions } from "./use-snapshot";

type Props = {
  session: SessionView | null;
  theme: PluginTheme;
  now: number;
  onClose(): void;
};

export function DeferMenu(props: Props) {
  const { session } = props;
  if (session === null) {
    return null;
  }
  return (
    <DeferMenuBody
      key={session.id}
      session={session}
      theme={props.theme}
      now={props.now}
      onClose={props.onClose}
    />
  );
}

function DeferMenuBody(props: {
  session: SessionView;
  theme: PluginTheme;
  now: number;
  onClose(): void;
}) {
  const { session, theme, now, onClose } = props;
  const { colors } = theme;
  const actions = useSessionActions();
  const [durationMs, setDurationMs] = useState<number>(DEFER_DURATIONS[2].ms);
  const [clockIndex, setClockIndex] = useState<number | null>(null);
  const [toQueue, setToQueue] = useState(false);
  const deferred = isDeferred(session, now);

  function confirm() {
    const target = clockIndex === null ? null : DEFER_CLOCK_TARGETS[clockIndex];
    const ms = target ? deferClockTimestamp(target, Date.now()) - Date.now() : durationMs;
    void actions.defer(session.id, ms, toQueue);
    onClose();
  }

  function resume() {
    void actions.clearDefer(session.id);
    onClose();
  }

  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 3000,
        elevation: 30,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="关闭延迟设置"
        onPress={onClose}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: "rgba(0,0,0,0.45)",
        }}
      />
      <View
        style={{
          width: 340,
          maxWidth: "92%",
          borderRadius: 12,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface0,
          padding: 14,
          gap: 12,
        }}
      >
        <View style={{ gap: 2 }}>
          <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "700" }}>延迟显示</Text>
          <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 12 }}>
            {sessionTitle(session)}
          </Text>
        </View>
        {deferred && session.deferredUntil !== null ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
            {`当前延迟至 ${formatDeferUntil(session.deferredUntil, now)}（${formatDeferRemaining(session.deferredUntil, now)}）`}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {DEFER_DURATIONS.map(function render(option) {
            return (
              <Chip
                key={option.ms}
                theme={theme}
                label={option.label}
                selected={clockIndex === null && durationMs === option.ms}
                onPress={function pick() {
                  setClockIndex(null);
                  setDurationMs(option.ms);
                }}
              />
            );
          })}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {DEFER_CLOCK_TARGETS.map(function renderClock(target, index) {
            if (deferClockTimestamp(target, now) <= now) {
              return null;
            }
            return (
              <Chip
                key={index}
                theme={theme}
                label={deferClockLabel(target)}
                selected={clockIndex === index}
                onPress={function pickClock() {
                  setClockIndex(index);
                }}
              />
            );
          })}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Chip
            theme={theme}
            label="移入延迟队列"
            selected={toQueue}
            onPress={function toggle() {
              setToQueue(!toQueue);
            }}
          />
        </View>
        <Text style={{ color: colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>
          {toQueue
            ? "卡片移到「延迟队列」列，到期自动回到按状态归属的列。"
            : "卡片留在原列底部并盖蒙版，到期自动恢复。"}
        </Text>
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
          {deferred ? (
            <Chip theme={theme} label="立即恢复" selected={false} onPress={resume} />
          ) : null}
          <Chip theme={theme} label="取消" selected={false} onPress={onClose} />
          <Chip theme={theme} label="确定" selected onPress={confirm} />
        </View>
      </View>
    </View>
  );
}
