/** React Native renderer for the small Markdown AST in ./parse. */
import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { memo, useMemo, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { withAlpha } from "../styles";
import { parseMarkdown, type Align, type Block, type Inline } from "./parse";

const MONO = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "ui-monospace, SFMono-Regular, Menlo, monospace",
});

const HEADING_SIZE = [20, 18, 16, 15, 15, 15];

interface Ctx {
  theme: PluginTheme;
  color: string;
  fontSize: number;
  lineHeight: number;
}

function isSafeUrl(url: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(url.trim());
}

function openUrl(url: string): void {
  if (!isSafeUrl(url)) return;
  openExternalUrl(url.trim()).catch(function ignore() {});
}

function renderInline(nodes: Inline[], ctx: Ctx, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const key = `${keyPrefix}${i}`;
    switch (node.t) {
      case "text":
        out.push(node.text);
        break;
      case "br":
        out.push("\n");
        break;
      case "bold":
        out.push(
          <Text key={key} style={{ fontWeight: "700" }}>
            {renderInline(node.children, ctx, key + ".")}
          </Text>,
        );
        break;
      case "italic":
        out.push(
          <Text key={key} style={{ fontStyle: "italic" }}>
            {renderInline(node.children, ctx, key + ".")}
          </Text>,
        );
        break;
      case "strike":
        out.push(
          <Text key={key} style={{ textDecorationLine: "line-through" }}>
            {renderInline(node.children, ctx, key + ".")}
          </Text>,
        );
        break;
      case "code":
        out.push(
          <Text
            key={key}
            style={{
              fontFamily: MONO,
              fontSize: ctx.fontSize - 1,
              backgroundColor: withAlpha(ctx.theme.colors.foreground, "1F", ctx.theme.colors.surface2),
            }}
          >
            {` ${node.text} `}
          </Text>,
        );
        break;
      case "link":
        out.push(
          <Text
            key={key}
            accessibilityRole="link"
            onPress={makeOpener(node.url)}
            style={{ color: ctx.theme.colors.accent, textDecorationLine: "underline" }}
          >
            {renderInline(node.children, ctx, key + ".")}
          </Text>,
        );
        break;
    }
  }
  return out;
}

function makeOpener(url: string): () => void {
  return function open() {
    openUrl(url);
  };
}

function InlineText(props: { nodes: Inline[]; ctx: Ctx; style?: object }) {
  const { ctx } = props;
  return (
    <Text
      selectable
      style={[
        { color: ctx.color, fontSize: ctx.fontSize, lineHeight: ctx.lineHeight },
        props.style,
      ]}
    >
      {renderInline(props.nodes, ctx, "i")}
    </Text>
  );
}

function CodeBlock(props: { ctx: Ctx; lang: string; text: string }) {
  const { colors } = props.ctx.theme;
  const toast = useToast();
  function copy() {
    copyText(props.text).then(
      function done() {
        toast.show("已复制");
      },
      function failed() {
        toast.error("复制失败");
      },
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
        <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{props.lang}</Text>
        <Pressable accessibilityRole="button" onPress={copy} hitSlop={6}>
          <Text style={{ color: colors.accent, fontSize: 11 }}>复制</Text>
        </Pressable>
      </View>
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
          {props.text}
        </Text>
      </ScrollView>
    </View>
  );
}

function cellAlign(align: Align): "left" | "right" | "center" {
  return align ?? "left";
}

function TableBlock(props: {
  ctx: Ctx;
  align: Align[];
  header: Inline[][];
  rows: Inline[][][];
}) {
  const { ctx } = props;
  const { colors } = ctx.theme;
  const renderRow = function renderRow(cells: Inline[][], head: boolean, rowIndex: number) {
    return (
      <View
        key={rowIndex}
        style={{
          flexDirection: "row",
          backgroundColor: head ? colors.surface2 : undefined,
        }}
      >
        {cells.map(function renderCell(cell, c) {
          return (
            <View
              key={c}
              style={{
                minWidth: 80,
                maxWidth: 280,
                paddingHorizontal: 8,
                paddingVertical: 5,
                borderRightWidth: c < cells.length - 1 ? 1 : 0,
                borderBottomWidth: 1,
                borderColor: colors.border,
              }}
            >
              <InlineText
                nodes={cell}
                ctx={ctx}
                style={{
                  textAlign: cellAlign(props.align[c] ?? null),
                  fontWeight: head ? "700" : "400",
                }}
              />
            </View>
          );
        })}
      </View>
    );
  };
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator>
      <View
        style={{
          borderWidth: 1,
          borderBottomWidth: 0,
          borderColor: colors.border,
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        {renderRow(props.header, true, -1)}
        {props.rows.map(function mapRow(row, r) {
          return renderRow(row, false, r);
        })}
      </View>
    </ScrollView>
  );
}

function renderBlocks(blocks: Block[], ctx: Ctx, gap: number): ReactNode {
  return (
    <View style={{ gap }}>
      {blocks.map(function renderBlock(block, index) {
        return <BlockView key={index} block={block} ctx={ctx} />;
      })}
    </View>
  );
}

function BlockView(props: { block: Block; ctx: Ctx }) {
  const { block, ctx } = props;
  const { colors } = ctx.theme;
  switch (block.type) {
    case "heading":
      return (
        <InlineText
          nodes={block.inline}
          ctx={ctx}
          style={{
            fontWeight: "700",
            fontSize: HEADING_SIZE[block.level - 1] ?? 15,
            lineHeight: (HEADING_SIZE[block.level - 1] ?? 15) + 8,
            marginTop: 4,
          }}
        />
      );
    case "paragraph":
      return <InlineText nodes={block.inline} ctx={ctx} />;
    case "code":
      return <CodeBlock ctx={ctx} lang={block.lang} text={block.text} />;
    case "hr":
      return <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 4 }} />;
    case "quote": {
      const quoteCtx: Ctx = { ...ctx, color: colors.foregroundMuted };
      return (
        <View style={{ borderLeftWidth: 3, borderLeftColor: colors.border, paddingLeft: 10 }}>
          {renderBlocks(block.children, quoteCtx, 4)}
        </View>
      );
    }
    case "list":
      return (
        <View style={{ gap: 3 }}>
          {block.items.map(function renderItem(item, index) {
            const marker =
              item.checked !== null
                ? item.checked
                  ? "☑"
                  : "☐"
                : block.ordered
                  ? `${block.start + index}.`
                  : "•";
            return (
              <View key={index} style={{ flexDirection: "row", gap: 6, paddingLeft: 4 }}>
                <Text
                  style={{
                    color: ctx.color,
                    fontSize: ctx.fontSize,
                    lineHeight: ctx.lineHeight,
                    minWidth: block.ordered ? 20 : 12,
                    textAlign: block.ordered ? "right" : "center",
                  }}
                >
                  {marker}
                </Text>
                <View style={{ flex: 1 }}>{renderBlocks(item.children, ctx, 3)}</View>
              </View>
            );
          })}
        </View>
      );
    case "table":
      return <TableBlock ctx={ctx} align={block.align} header={block.header} rows={block.rows} />;
  }
}

function MarkdownImpl(props: {
  text: string;
  theme: PluginTheme;
  compact?: boolean;
  color?: string;
}) {
  const blocks = useMemo(
    function parse() {
      return parseMarkdown(props.text);
    },
    [props.text],
  );
  const compact = props.compact === true;
  const ctx: Ctx = {
    theme: props.theme,
    color: props.color ?? props.theme.colors.foreground,
    fontSize: compact ? 12 : 13,
    lineHeight: compact ? 18 : 20,
  };
  return renderBlocks(blocks, ctx, compact ? 4 : 8);
}

export const Markdown = memo(MarkdownImpl);
