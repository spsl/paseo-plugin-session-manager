/**
 * Context-usage ring (P1a): a 14px ring inside a 28x28 target, composed of a
 * surface3 track plus a progress arc. The arc uses the classic two-clip
 * construction: each half of the circle has an overflow-hidden window holding
 * a rotating square with a D-shaped semicircle inside, so the arc sweeps
 * clockwise from 12 o'clock. Colors follow Paseo's thresholds: >90%
 * destructive, >=70% warning, otherwise foregroundMuted.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, View } from "react-native";
import type { ComposerPalette } from "./composer-tokens";

const RING = 14;
const HALF = RING / 2;
const BORDER = 1.75;

export function contextColor(palette: ComposerPalette, warning: string, pct: number): string {
  if (pct > 90) {
    return palette.destructive;
  }
  if (pct >= 70) {
    return warning;
  }
  return palette.foregroundMuted;
}

/** D-shaped right semicircle stroke drawn at the right edge of a RING box. */
function RightSemi(props: { color: string }) {
  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: HALF,
        width: HALF,
        height: RING,
        borderTopWidth: BORDER,
        borderRightWidth: BORDER,
        borderBottomWidth: BORDER,
        borderLeftWidth: 0,
        borderColor: props.color,
        borderTopRightRadius: HALF,
        borderBottomRightRadius: HALF,
      }}
    />
  );
}

function HalfClip(props: { color: string; side: "left" | "right"; degrees: number }) {
  const right = props.side === "right";
  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: right ? HALF : 0,
        width: HALF,
        height: RING,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          position: "absolute",
          top: 0,
          left: right ? -HALF : 0,
          width: RING,
          height: RING,
          transform: [{ rotate: `${props.degrees}deg` }],
        }}
      >
        <RightSemi color={props.color} />
      </View>
    </View>
  );
}

export function ContextMeter(props: {
  theme: PluginTheme;
  palette: ComposerPalette;
  used: number;
  max: number;
  onPress?(): void;
}) {
  const { palette } = props;
  const pct = props.max > 0 ? Math.min(100, Math.max(0, (props.used / props.max) * 100)) : 0;
  const color = contextColor(palette, props.theme.colors.statusWarning, pct);
  // Right window shows the first 180deg of the sweep: its semicircle starts
  // rotated out of view (-180) and comes to rest at 0deg (50% progress).
  const rightDegrees = Math.min(0, (pct / 100) * 360 - 180);
  // Left window takes over past 50%: the same semicircle rotates 0 -> 180deg.
  const leftDegrees = Math.max(0, (pct / 100) * 360 - 180);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`上下文 ${Math.round(pct)}%`}
      onPress={props.onPress}
      style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center" }}
    >
      <View style={{ width: RING, height: RING }}>
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: RING,
            height: RING,
            borderRadius: HALF,
            borderWidth: BORDER,
            borderColor: palette.surface3,
          }}
        />
        {pct > 0 ? <HalfClip color={color} side="right" degrees={rightDegrees} /> : null}
        {pct > 50 ? <HalfClip color={color} side="left" degrees={leftDegrees} /> : null}
      </View>
    </Pressable>
  );
}
