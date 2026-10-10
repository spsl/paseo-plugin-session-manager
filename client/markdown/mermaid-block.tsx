/**
 * Mermaid code block: the daemon renders the source to PNG (`mermaid.render`
 * RPC, mermaid-cli + local Chrome) and this draws it with RN <Image>. Falls
 * back to plain source on failure. No DOM/svg ever reaches Hermes.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { mermaidRenderRpc } from "../../shared/rpc";
import { errorText } from "../styles";
import { appearanceForSurface } from "./theme-mode";

const MONO = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "ui-monospace, SFMono-Regular, Menlo, monospace",
});

const IMAGE_PADDING = 8;

export function MermaidBlock(props: { theme: PluginTheme; code: string }) {
  const { colors } = props.theme;
  const toast = useToast();
  const [showSource, setShowSource] = useState(false);
  const [innerWidth, setInnerWidth] = useState(0);
  const render = useRpc(mermaidRenderRpc);
  const appearance = appearanceForSurface(colors.surface0);
  const query = useQuery({
    queryKey: ["session-manager", "mermaid", appearance, props.code],
    queryFn: async function load() {
      return render({ code: props.code, theme: appearance });
    },
    staleTime: Infinity,
    retry: false,
  });
  const chart = query.data !== undefined && query.data.ok ? query.data : null;
  const failure =
    query.data !== undefined && !query.data.ok
      ? query.data.error
      : query.isError
        ? errorText(query.error)
        : null;

  function copy() {
    copyText(props.code).then(
      function done() {
        toast.show("已复制");
      },
      function failed() {
        toast.error("复制失败");
      },
    );
  }
  function toggle() {
    setShowSource(!showSource);
  }
  function layout(event: LayoutChangeEvent): void {
    setInnerWidth(event.nativeEvent.layout.width);
  }

  const source = (
    <ScrollView horizontal showsHorizontalScrollIndicator>
      <Text
        selectable
        style={{
          padding: 8,
          color: colors.foreground,
          fontFamily: MONO,
          fontSize: 12,
          lineHeight: 18,
        }}
      >
        {props.code}
      </Text>
    </ScrollView>
  );

  function body(): ReactNode {
    if (showSource) {
      return source;
    }
    if (query.isPending) {
      return (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, padding: 8 }}>
          <ActivityIndicator size="small" color={colors.foregroundMuted} />
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>正在渲染图表…</Text>
        </View>
      );
    }
    if (chart === null || chart.width <= 0 || chart.height <= 0) {
      return (
        <View>
          {source}
          <Text
            style={{
              color: colors.foregroundMuted,
              fontSize: 11,
              paddingHorizontal: 8,
              paddingBottom: 8,
            }}
          >
            {`图表渲染失败：${failure ?? "未知错误"}`}
          </Text>
        </View>
      );
    }
    // Natural logical size when it fits; scaled down to the body width when not.
    const available = innerWidth > 0 ? Math.max(innerWidth - IMAGE_PADDING * 2, 1) : chart.width;
    const width = Math.min(chart.width, available);
    const height = (chart.height / chart.width) * width;
    return (
      <View style={{ padding: IMAGE_PADDING }}>
        <Image
          accessibilityLabel="mermaid 图表"
          source={{ uri: `data:image/png;base64,${chart.png}` }}
          style={{ width, height }}
          resizeMode="contain"
        />
      </View>
    );
  }

  return (
    <View
      style={{
        borderRadius: 6,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 8,
          paddingVertical: 3,
          backgroundColor: colors.surface2,
        }}
      >
        <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>mermaid</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          {chart !== null ? (
            <Pressable accessibilityRole="button" onPress={toggle} hitSlop={6}>
              <Text style={{ color: colors.accent, fontSize: 11 }}>
                {showSource ? "图表" : "源码"}
              </Text>
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="button" onPress={copy} hitSlop={6}>
            <Text style={{ color: colors.accent, fontSize: 11 }}>复制</Text>
          </Pressable>
        </View>
      </View>
      <View onLayout={layout}>{body()}</View>
    </View>
  );
}
