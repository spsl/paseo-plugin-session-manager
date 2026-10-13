/**
 * Paseo-aligned composer: rounded framed input (no inner borders/focus ring),
 * autogrow textarea, a button row of "+" / agent controls / context ring /
 * primary action, a queue strip with edit + send-now entries, and a slash
 * completion popover. All send decisions are delegated to the pane's
 * submitter (composer-logic); keyboard handling mirrors the host composer.
 * Async function expressions only (Hermes).
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  Text,
  useWindowDimensions,
  View,
  type TextInput as TextInputHandle,
} from "react-native";
import type { Liveness } from "../../shared/types";
import { AgentControls, type OptionChoice } from "./agent-controls";
import { AttachmentTray } from "./attachment-tray";
import type { ComposerImage } from "./composer-images";
import {
  applySlashCommandReplacement,
  clampComposerHeight,
  composerMaxHeight,
  composerMinHeight,
  findActiveSlashCommand,
  keyIntent,
  nextModeId,
  placeholderFor,
  primaryAction,
  rankSlashEntries,
  type KeyInfo,
  type SlashCommandEntry,
  type SubmitKind,
} from "./composer-logic";
import { ComposerMenu } from "./composer-menu";
import { composerPalette } from "./composer-tokens";
import { ContextMeter } from "./context-meter";
import type { QueuedMessage } from "./queue";
import { SlashPopover } from "./slash-popover";
import {
  attachComposerDomListeners,
  autofocusInput,
  canMeasureTextarea,
  domInputNode,
  focusInput,
  hasPrecisePointer,
  measureTextarea,
  pickImages,
  readImageFile,
  type DomNode,
} from "./web-attachments";

type KeyPressEvent = {
  nativeEvent: KeyInfo & { preventDefault?: () => void };
};

type SelectionEvent = {
  nativeEvent: { selection?: { start: number; end: number } };
};

/** RN's Pressable state lacks the web-only `hovered` flag in these types. */
type HoverState = { hovered?: boolean };

function isHovered(state: unknown): boolean {
  return (state as HoverState).hovered === true;
}

const EMPTY_ENTRIES: readonly SlashCommandEntry[] = [];

function QueuedRow(props: {
  palette: ReturnType<typeof composerPalette>;
  message: QueuedMessage;
  onEdit(): void;
  onSendNow(): void;
}) {
  const { palette } = props;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: palette.surface1,
        borderWidth: 1,
        borderColor: palette.border,
        borderRadius: 8,
      }}
    >
      <Text
        numberOfLines={2}
        style={{ flex: 1, minWidth: 0, color: palette.foreground, fontSize: 14, lineHeight: 20 }}
      >
        {props.message.text}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="编辑这条排队消息"
        onPress={props.onEdit}
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: palette.surface2,
        }}
      >
        <Icon name="Pencil" size={14} color={palette.foreground} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="立即发送这条排队消息"
        onPress={props.onSendNow}
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: palette.accent,
        }}
      >
        <Icon name="ArrowUp" size={14} color={palette.accentForeground} />
      </Pressable>
    </View>
  );
}

function RoundButton(props: {
  backgroundColor: string;
  onPress(): void;
  accessibilityLabel: string;
  disabled?: boolean;
  hoveredColor?: string;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      disabled={props.disabled === true}
      onPress={props.onPress}
      style={function circle(state) {
        return {
          width: 28,
          height: 28,
          borderRadius: 14,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: isHovered(state)
            ? (props.hoveredColor ?? props.backgroundColor)
            : props.backgroundColor,
          opacity: props.disabled === true ? 0.5 : 1,
        };
      }}
    >
      {props.children}
    </Pressable>
  );
}

export function Composer(props: {
  theme: PluginTheme;
  liveness: Liveness;
  compact: boolean;
  value: string;
  onChange(value: string): void;
  images: readonly ComposerImage[];
  onAddImages(images: ComposerImage[]): void;
  onRemoveImage(id: string): void;
  running: boolean;
  sending: boolean;
  stopping: boolean;
  sendError: string | null;
  queued: readonly QueuedMessage[];
  onEditQueued(message: QueuedMessage): void;
  onSendQueuedNow(message: QueuedMessage): void;
  onSubmit(kind: SubmitKind): void;
  onStop(): void;
  slashCommands: readonly SlashCommandEntry[] | null;
  onSlashNeeded(): void;
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
  usage: { used: number; max: number } | null;
}) {
  const palette = composerPalette(props.theme);
  const isWeb = Platform.OS === "web";
  const win = useWindowDimensions();
  const wide = win.width >= 720;
  const minHeight = composerMinHeight(isWeb);
  const maxHeight = composerMaxHeight(win.height);
  const submitOnEnter = isWeb && !props.compact;

  const inputRef = useRef<TextInputHandle | null>(null);
  const boxRef = useRef<View | null>(null);
  const [inputDom, setInputDom] = useState<DomNode | null>(null);
  const [boxDom, setBoxDom] = useState<DomNode | null>(null);
  const [inputHeight, setInputHeight] = useState(minHeight);
  const [inputWidth, setInputWidth] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [frameWidth, setFrameWidth] = useState(0);

  // Resolve the underlying DOM nodes once on web; they gate DOM measuring,
  // paste/drag listeners and the "+" menu (feature detection, Hermes-safe).
  useEffect(
    function detectDom() {
      if (!isWeb) {
        return;
      }
      setInputDom(domInputNode(inputRef.current));
      setBoxDom(domInputNode(boxRef.current));
    },
    [isWeb],
  );
  const domReady = inputDom !== null && canMeasureTextarea(inputDom);
  const imageSupport = isWeb && inputDom !== null && boxDom !== null;

  const applyHeight = useCallback(
    function applyHeight(measured: number): void {
      const clamped = clampComposerHeight(measured, minHeight, maxHeight);
      setInputHeight(function pick(previous) {
        return Math.abs(previous - clamped) < 1 ? previous : clamped;
      });
    },
    [minHeight, maxHeight],
  );

  // Autogrow: DOM scrollHeight when measurable, invisible mirror Text
  // otherwise (web), onContentSizeChange on Hermes.
  useEffect(
    function measure() {
      if (!isWeb || !domReady || inputDom === null) {
        return;
      }
      applyHeight(measureTextarea(inputDom));
    },
    [isWeb, domReady, inputDom, props.value, inputWidth, applyHeight],
  );

  const handleFiles = useCallback(
    function handleFiles(files: unknown[]): void {
      files.forEach(function read(file) {
        readImageFile(file, function done(image, error) {
          if (image !== null) {
            props.onAddImages([image]);
            setAttachError(null);
          } else {
            setAttachError(error);
          }
        });
      });
    },
    [props.onAddImages],
  );
  const filesRef = useRef(handleFiles);
  filesRef.current = handleFiles;

  useEffect(
    function attachDom() {
      if (!imageSupport) {
        return undefined;
      }
      return attachComposerDomListeners(inputDom, boxDom, {
        onImageFiles(files) {
          filesRef.current(files);
        },
        onDragActive: setDragActive,
      });
    },
    [imageSupport, inputDom, boxDom],
  );

  // Autofocus on precise-pointer web hosts, retrying for ~1.5s while the host
  // may still be moving focus; refocus after a send/stop round finishes.
  useEffect(
    function autofocus() {
      if (!isWeb || props.compact || !hasPrecisePointer()) {
        return undefined;
      }
      return autofocusInput(domInputNode(inputRef.current));
    },
    [isWeb, props.compact],
  );
  const wasBusy = useRef(false);
  useEffect(
    function refocus() {
      const busy = props.sending || props.stopping;
      if (wasBusy.current && !busy && isWeb) {
        focusInput(domInputNode(inputRef.current));
      }
      wasBusy.current = busy;
    },
    [props.sending, props.stopping, isWeb],
  );

  // Slash completion: the match is tracked from text + cursor; the pane is
  // asked to load provider commands on the first match.
  const slashMatch = findActiveSlashCommand(props.value, selection.start);
  const slashActive = slashMatch !== null;
  useEffect(
    function requestSlash() {
      if (slashActive) {
        props.onSlashNeeded();
      }
    },
    [slashActive, props.onSlashNeeded],
  );
  const slashEntries =
    props.slashCommands !== null && slashMatch !== null && !slashDismissed
      ? rankSlashEntries(props.slashCommands, slashMatch)
      : EMPTY_ENTRIES;
  const popoverOpen = slashEntries.length > 0;
  const slashKey = slashMatch === null ? "" : `${slashMatch.start}:${slashMatch.query}`;
  useEffect(
    function resetHighlight() {
      setHighlight(0);
    },
    [slashKey],
  );

  function acceptSlash(entry: SlashCommandEntry): void {
    if (slashMatch === null) {
      return;
    }
    const next = applySlashCommandReplacement(props.value, slashMatch, entry.name);
    props.onChange(next);
    setSelection({ start: slashMatch.start + entry.name.length + 2, end: 0 });
    setSlashDismissed(true);
  }

  function onKeyPress(event: KeyPressEvent): void {
    const native = event.nativeEvent;
    if (popoverOpen) {
      const key = native.key;
      if (key === "ArrowDown" || key === "ArrowUp") {
        native.preventDefault?.();
        setHighlight(function move(previous) {
          const delta = key === "ArrowDown" ? 1 : -1;
          const next = previous + delta;
          return Math.max(0, Math.min(slashEntries.length - 1, next));
        });
        return;
      }
      if (key === "Enter" || key === "Tab") {
        if (key === "Tab" || (native.shiftKey !== true && native.metaKey !== true && native.ctrlKey !== true)) {
          native.preventDefault?.();
          const entry = slashEntries[Math.min(highlight, slashEntries.length - 1)];
          if (entry !== undefined) {
            acceptSlash(entry);
          }
          return;
        }
      }
      if (key === "Escape") {
        native.preventDefault?.();
        setSlashDismissed(true);
        return;
      }
    }
    const intent = keyIntent(native, {
      submitOnEnter,
      running: props.running,
      sending: props.sending,
      canCycleMode: (props.modes?.list.length ?? 0) > 1,
    });
    if (intent === "submit-default") {
      native.preventDefault?.();
      props.onSubmit("default");
    } else if (intent === "submit-alternate") {
      native.preventDefault?.();
      props.onSubmit("alternate");
    } else if (intent === "interrupt") {
      native.preventDefault?.();
      props.onStop();
    } else if (intent === "cycle-mode") {
      native.preventDefault?.();
      if (props.modes !== null) {
        const next = nextModeId(props.modes.list, props.modes.currentId);
        if (next !== null) {
          props.modes.onSelect(next);
        }
      }
    }
  }

  function onChangeText(text: string): void {
    setSlashDismissed(false);
    props.onChange(text);
  }

  function onSelectionChange(event: SelectionEvent): void {
    const next = event.nativeEvent.selection;
    if (next !== undefined) {
      setSelection(next);
    }
  }

  if (props.liveness === "archived") {
    return (
      <View
        style={{
          borderRadius: 16,
          borderWidth: 1,
          borderStyle: "dotted",
          borderColor: palette.borderAccent,
          backgroundColor: palette.surface1,
          paddingHorizontal: 16,
          paddingVertical: 14,
          alignItems: "center",
        }}
      >
        <Text style={{ color: palette.foregroundMuted, fontSize: 14 }}>此 Agent 已归档</Text>
      </View>
    );
  }

  const error = props.sendError ?? attachError;
  const action = primaryAction({
    hasContent: props.value.trim() !== "" || props.images.length > 0,
    running: props.running,
    sending: props.sending,
  });
  const condensed: 0 | 1 | 2 = frameWidth > 0 && frameWidth < 340 ? 2 : frameWidth > 0 && frameWidth < 420 ? 1 : 0;

  return (
    <View style={{ gap: 12 }}>
      {props.queued.length > 0 ? (
        <View style={{ gap: 8 }}>
          {props.queued.map(function renderQueued(message) {
            return (
              <QueuedRow
                key={message.id}
                palette={palette}
                message={message}
                onEdit={function edit() {
                  props.onEditQueued(message);
                }}
                onSendNow={function sendNow() {
                  props.onSendQueuedNow(message);
                }}
              />
            );
          })}
        </View>
      ) : null}

      {error !== null ? (
        <Text accessibilityRole="alert" style={{ color: palette.error, fontSize: 13 }}>
          {error}
        </Text>
      ) : null}

      <View style={{ position: "relative" }}>
        {popoverOpen ? (
          <SlashPopover
            palette={palette}
            entries={slashEntries}
            highlight={highlight}
            onPick={acceptSlash}
          />
        ) : null}
        <View
          ref={boxRef}
          onLayout={function layout(event) {
            setFrameWidth(event.nativeEvent.layout.width);
          }}
          style={{
            borderRadius: 16,
            borderWidth: 1,
            borderColor: palette.borderAccent,
            backgroundColor: palette.surface1,
            paddingTop: wide ? 16 : 8,
            paddingBottom: wide ? 12 : 8,
            paddingHorizontal: wide ? 16 : 12,
            gap: 12,
          }}
        >
          {dragActive ? (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                borderRadius: 16,
                backgroundColor: palette.surface0,
                opacity: 0.7,
                alignItems: "center",
                justifyContent: "center",
                zIndex: 30,
              }}
            >
              <Text style={{ color: palette.foreground, fontSize: 14 }}>将图片拖放到这里</Text>
            </View>
          ) : null}

          {props.images.length > 0 ? (
            <AttachmentTray
              palette={palette}
              images={props.images}
              onRemove={props.onRemoveImage}
            />
          ) : null}

          <View
            onLayout={function layout(event) {
              setInputWidth(event.nativeEvent.layout.width);
            }}
          >
            <TextInput
              ref={inputRef}
              value={props.value}
              onChangeText={onChangeText}
              onSelectionChange={onSelectionChange}
              onKeyPress={onKeyPress}
              onContentSizeChange={function sized(event) {
                if (!isWeb) {
                  applyHeight(event.nativeEvent.contentSize.height);
                }
              }}
              multiline
              autoCorrect={false}
              accessibilityLabel="给 Agent 发消息"
              placeholder={placeholderFor({
                compact: props.compact,
                slash: props.slashCommands !== null,
                mentions: false,
              })}
              placeholderTextColor={palette.surface4}
              style={{
                width: "100%",
                height: inputHeight,
                color: palette.foreground,
                fontSize: 15,
                lineHeight: 21,
                fontWeight: "400",
                padding: 0,
                paddingHorizontal: 0,
                paddingVertical: 0,
                borderWidth: 0,
                outlineWidth: 0,
                outlineColor: "transparent",
                textAlignVertical: "top",
              }}
            />
            {isWeb && !domReady ? (
              <Text
                pointerEvents="none"
                onLayout={function layout(event) {
                  applyHeight(event.nativeEvent.layout.height);
                }}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: inputWidth > 0 ? inputWidth : "100%",
                  opacity: 0,
                  fontSize: 15,
                  lineHeight: 21,
                }}
              >
                {props.value === "" ? " " : props.value.endsWith("\n") ? `${props.value} ` : props.value}
              </Text>
            ) : null}
          </View>

          <View
            style={{
              marginHorizontal: -6,
              flexDirection: "row",
              alignItems: "flex-end",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 2, flexShrink: 1 }}>
              {imageSupport ? (
                <View style={{ position: "relative" }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="添加"
                    onPress={function toggle() {
                      setAttachOpen(function flip(open) {
                        return !open;
                      });
                    }}
                    style={function plus(state) {
                      return {
                        width: 28,
                        height: 28,
                        borderRadius: 14,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: isHovered(state) ? palette.surface2 : "transparent",
                      };
                    }}
                  >
                    <Icon name="Plus" size={16} color={palette.foregroundMuted} />
                  </Pressable>
                  {attachOpen ? (
                    <ComposerMenu
                      palette={palette}
                      items={[{ id: "image", label: "添加图片", icon: "ImagePlus" }]}
                      onSelect={function pick() {
                        pickImages(function picked(files) {
                          filesRef.current(files);
                        });
                      }}
                      onClose={function close() {
                        setAttachOpen(false);
                      }}
                    />
                  ) : null}
                </View>
              ) : null}
              <AgentControls
                palette={palette}
                modelLabel={props.modelLabel}
                thinking={props.thinking}
                modes={props.modes}
                condensed={condensed}
              />
            </View>

            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              {props.usage !== null ? (
                <ContextMeter
                  theme={props.theme}
                  palette={palette}
                  used={props.usage.used}
                  max={props.usage.max}
                />
              ) : null}
              {action === "send" ? (
                <RoundButton
                  backgroundColor={palette.accent}
                  hoveredColor={palette.accent}
                  accessibilityLabel="发送"
                  disabled={props.sending}
                  onPress={function send() {
                    props.onSubmit("default");
                  }}
                >
                  {props.sending ? (
                    <ActivityIndicator size={14} color={palette.accentForeground} />
                  ) : (
                    <Icon name="ArrowUp" size={16} color={palette.accentForeground} />
                  )}
                </RoundButton>
              ) : action === "stop" ? (
                <RoundButton
                  backgroundColor={palette.stop}
                  hoveredColor={palette.stop}
                  accessibilityLabel="停止"
                  disabled={props.stopping}
                  onPress={function stop() {
                    props.onStop();
                  }}
                >
                  {props.stopping ? (
                    <ActivityIndicator size={14} color={palette.stopForeground} />
                  ) : (
                    <Icon name="Square" size={12} color={palette.stopForeground} />
                  )}
                </RoundButton>
              ) : null}
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}
