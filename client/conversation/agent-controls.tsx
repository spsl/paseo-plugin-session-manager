/**
 * Agent controls in the composer's button row (P1a read-only model label,
 * P1b thinking-option and mode pickers through the CLI RPCs). Order: model,
 * thinking, mode — same as Paseo. Buttons are 28px tall transparent chips
 * with a surface2 hover; when the row is tight the chevron and labels are
 * progressively hidden.
 */
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { ComposerMenu, type ComposerMenuItem } from "./composer-menu";
import type { ComposerPalette } from "./composer-tokens";

export type OptionChoice = { id: string; label: string; icon?: string };

export type ControlKind = "thinking" | "mode";

/**
 * Icon names provably present in the host's icon component (the Shield
 * family the daemon emits for modes plus every name this plugin renders).
 * Unknown provider names fall back to Shield, per the design contract.
 */
const KNOWN_ICONS = new Set([
  "AppWindow",
  "ArrowUp",
  "Brain",
  "Check",
  "ChevronDown",
  "CircleAlert",
  "ImagePlus",
  "Kanban",
  "Pencil",
  "Plus",
  "Search",
  "Settings",
  "Shield",
  "ShieldCheck",
  "ShieldEllipsis",
  "ShieldOff",
  "Timer",
  "TimerOff",
  "X",
]);

/** Mode anchor icon: unknown provider names degrade to Shield. */
export function modeIcon(icon: string | undefined): string {
  return icon !== undefined && KNOWN_ICONS.has(icon) ? icon : "Shield";
}

/** Menu row icon: unknown names show no icon, like Paseo. */
export function menuIcon(icon: string | undefined): string | undefined {
  return icon !== undefined && KNOWN_ICONS.has(icon) ? icon : undefined;
}

function AnchorButton(props: {
  palette: ComposerPalette;
  icon?: string;
  label?: string;
  chevron: boolean;
  pending: boolean;
  /** Menu open or pressed -> surface0, hover -> surface2, else transparent. */
  active: boolean;
  accessibilityLabel: string;
  onPress(): void;
}) {
  const { palette } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      onPress={props.onPress}
      style={function chip(state) {
        return {
          height: 28,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: 8,
          borderRadius: 16,
          backgroundColor:
            props.active || state.pressed
              ? palette.surface0
              : (state as { hovered?: boolean }).hovered === true
                ? palette.surface2
                : "transparent",
        };
      }}
    >
      {props.icon !== undefined ? (
        <Icon name={props.icon} size={14} color={palette.foregroundMuted} />
      ) : null}
      {props.label !== undefined ? (
        <Text style={{ color: palette.foregroundMuted, fontSize: 14 }}>{props.label}</Text>
      ) : null}
      {props.pending ? (
        <ActivityIndicator size={10} color={palette.foregroundMuted} />
      ) : props.chevron ? (
        <Icon name="ChevronDown" size={14} color={palette.foregroundMuted} />
      ) : null}
    </Pressable>
  );
}

export function AgentControls(props: {
  palette: ComposerPalette;
  modelLabel: string | null;
  thinking: {
    options: readonly OptionChoice[];
    currentId: string | null;
    pending: boolean;
    onSelect(id: string): void;
  } | null;
  modes: {
    list: readonly OptionChoice[];
    currentId: string | null;
    pending: boolean;
    onSelect(id: string): void;
  } | null;
  /** 0 full; 1 hides chevrons and thinking text; 2 also hides the mode text. */
  condensed: 0 | 1 | 2;
}) {
  const { palette } = props;
  const [open, setOpen] = useState<ControlKind | null>(null);

  function menuItems(options: readonly OptionChoice[], currentId: string | null): ComposerMenuItem[] {
    return options.map(function toItem(option) {
      return {
        id: option.id,
        label: option.label,
        icon: menuIcon(option.icon),
        selected: option.id === currentId,
      };
    });
  }

  const thinkingOptions = props.thinking?.options ?? null;
  const thinkingCurrent =
    thinkingOptions?.find(function byId(option) {
      return option.id === props.thinking?.currentId;
    }) ?? null;
  const modeCurrent =
    props.modes?.list.find(function byId(mode) {
      return mode.id === props.modes?.currentId;
    }) ?? null;

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
      {props.modelLabel !== null ? (
        <View style={{ height: 28, justifyContent: "center", paddingHorizontal: 8 }}>
          <Text style={{ color: palette.foregroundMuted, fontSize: 14 }} numberOfLines={1}>
            {props.modelLabel}
          </Text>
        </View>
      ) : null}
      {props.thinking !== null && thinkingOptions !== null && thinkingOptions.length > 0 ? (
        <View style={{ position: "relative" }}>
          <AnchorButton
            palette={palette}
            icon="Brain"
            label={
              props.condensed >= 1
                ? undefined
                : (thinkingCurrent?.label ?? "思考")
            }
            chevron={props.condensed === 0}
            pending={props.thinking.pending}
            active={open === "thinking"}
            accessibilityLabel="选择思考档位"
            onPress={function openThinking() {
              setOpen(open === "thinking" ? null : "thinking");
            }}
          />
          {open === "thinking" ? (
            <ComposerMenu
              palette={palette}
              items={menuItems(thinkingOptions, props.thinking.currentId)}
              onSelect={function pick(id) {
                props.thinking?.onSelect(id);
              }}
              onClose={function close() {
                setOpen(null);
              }}
            />
          ) : null}
        </View>
      ) : null}
      {props.modes !== null && props.modes.list.length > 0 ? (
        <View style={{ position: "relative" }}>
          <AnchorButton
            palette={palette}
            icon={modeIcon(modeCurrent?.icon)}
            label={props.condensed >= 2 ? undefined : (modeCurrent?.label ?? "模式")}
            chevron={props.condensed === 0}
            pending={props.modes.pending}
            active={open === "mode"}
            accessibilityLabel="切换模式"
            onPress={function openModes() {
              setOpen(open === "mode" ? null : "mode");
            }}
          />
          {open === "mode" ? (
            <ComposerMenu
              palette={palette}
              items={menuItems(props.modes.list, props.modes.currentId)}
              onSelect={function pick(id) {
                props.modes?.onSelect(id);
              }}
              onClose={function close() {
                setOpen(null);
              }}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
