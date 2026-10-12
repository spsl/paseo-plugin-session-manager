/** Rendering of conversation rows (Markdown text, collapsible tool calls). */
import type { PluginTheme } from "@getpaseo/plugin";
import { memo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Markdown } from "../markdown/markdown";
import { toolBody, toolSummary, type Row } from "./model";
import { withAlpha } from "../styles";
import { SessionTimelineCard } from "../timeline-card";
import { SESSION_CARD_KIND, SESSION_CARD_VERSION } from "../../shared/card";

function Collapsible(props: {
  theme: PluginTheme;
  summary: string;
  tone?: string;
  children: string;
  markdown?: boolean;
}) {
  const { colors } = props.theme;
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        onPress={function toggle() {
          setOpen(!open);
        }}
        style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
      >
        <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{open ? "▾" : "▸"}</Text>
        <Text
          numberOfLines={open ? undefined : 1}
          style={{ flex: 1, color: props.tone ?? colors.foregroundMuted, fontSize: 12 }}
        >
          {props.summary}
        </Text>
      </Pressable>
      {open && props.children !== "" ? (
        <View
          style={{
            marginLeft: 14,
            padding: 8,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface0,
          }}
        >
          {props.markdown ? (
            <Markdown theme={props.theme} text={props.children} compact />
          ) : (
            <Text
              selectable
              style={{ color: colors.foreground, fontFamily: "monospace", fontSize: 11, lineHeight: 16 }}
            >
              {props.children}
            </Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

function toolStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "运行中";
    case "completed":
      return "完成";
    case "failed":
      return "失败";
    case "canceled":
      return "已取消";
    default:
      return status;
  }
}

function ConversationRowView(props: { theme: PluginTheme; row: Row; compact: boolean }) {
  const { theme, row } = props;
  const { colors } = theme;
  switch (row.kind) {
    case "user":
      return (
        <View style={{ alignItems: "flex-end" }}>
          <View
            style={{
              maxWidth: "85%",
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: 12,
              backgroundColor: withAlpha(colors.accent, "33", colors.surface2),
            }}
          >
            <Markdown theme={theme} text={row.text} />
          </View>
        </View>
      );
    case "assistant":
      return row.text.trim() === "" ? null : <Markdown theme={theme} text={row.text} />;
    case "reasoning":
      return (
        <Collapsible
          theme={theme}
          markdown
          summary={`思考… ${row.text.replace(/\s+/g, " ").slice(0, 80)}`}
        >
          {row.text}
        </Collapsible>
      );
    case "tool": {
      const summary = toolSummary(row.detail);
      const failed = row.status === "failed";
      return (
        <Collapsible
          theme={theme}
          tone={failed ? colors.statusDanger : colors.foregroundMuted}
          summary={`${row.name}${summary ? ` · ${summary}` : ""} · ${toolStatusLabel(row.status)}`}
        >
          {toolBody(row.detail, row.error)}
        </Collapsible>
      );
    }
    case "todo":
      return (
        <View
          style={{
            gap: 3,
            padding: 8,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface1,
          }}
        >
          <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>任务清单</Text>
          {row.items.map(function renderItem(item, index) {
            return (
              <Text
                key={index}
                style={{
                  color: item.completed ? colors.foregroundMuted : colors.foreground,
                  fontSize: 12,
                  lineHeight: 18,
                  textDecorationLine: item.completed ? "line-through" : "none",
                }}
              >
                {`${item.completed ? "☑" : item.inProgress ? "▶" : "☐"} ${item.text}`}
              </Text>
            );
          })}
        </View>
      );
    case "session-card":
      return (
        <SessionTimelineCard
          theme={theme}
          host={{ id: "session-manager", label: "会话看板" }}
          layout={{ compact: props.compact, platform: "web" }}
          agentId=""
          timestamp={new Date(0)}
          item={{
            type: "plugin",
            kind: SESSION_CARD_KIND,
            version: SESSION_CARD_VERSION,
            data: row.data,
          }}
        />
      );
    case "error":
      return (
        <Text selectable style={{ color: colors.statusDanger, fontSize: 12, lineHeight: 18 }}>
          {`错误：${row.message}`}
        </Text>
      );
    case "note": {
      const tone =
        row.level === "error"
          ? colors.statusDanger
          : row.level === "warning"
            ? colors.statusWarning
            : colors.foregroundMuted;
      return <Text style={{ color: tone, fontSize: 11 }}>{row.text}</Text>;
    }
  }
}

export const RowView = memo(ConversationRowView);
