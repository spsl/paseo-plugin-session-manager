import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { COLUMNS } from "../shared/presentation";
import type { BoardColumn, SessionView } from "../shared/types";
import { BOARD_GAP, BOARD_PADDING, columnWidthFor, MIN_COLUMN_WIDTH } from "./board-model";
import { SessionCard } from "./session-card";
import { columnTone } from "./styles";

type ColumnDef = (typeof COLUMNS)[number];

type CommonProps = {
  theme: PluginTheme;
  now: number;
  groups: Record<BoardColumn, SessionView[]>;
  onOpen(session: SessionView): void;
  onDefer(session: SessionView): void;
  onResume(session: SessionView): void;
};

function CardList(props: CommonProps & { column: ColumnDef }) {
  const { theme, column } = props;
  const sessions = props.groups[column.id];
  return (
    <ScrollView
      style={{ flex: 1 }}
      nestedScrollEnabled
      contentContainerStyle={{ gap: 8, padding: 8, paddingTop: 0 }}
    >
      {sessions.length === 0 ? (
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            textAlign: "center",
            paddingVertical: 12,
          }}
        >
          暂无会话
        </Text>
      ) : (
        sessions.map(function renderCard(session) {
          return (
            <SessionCard
              key={session.id}
              session={session}
              theme={theme}
              now={props.now}
              onOpen={props.onOpen}
              onDefer={props.onDefer}
              onResume={props.onResume}
            />
          );
        })
      )}
    </ScrollView>
  );
}

function BoardColumnView(props: CommonProps & { column: ColumnDef; width: number | null }) {
  const { theme, column } = props;
  const { colors } = theme;
  const tone = columnTone(theme, column.id);

  return (
    <View
      style={{
        ...(props.width === null
          ? { flexGrow: 1, flexBasis: MIN_COLUMN_WIDTH, minWidth: MIN_COLUMN_WIDTH }
          : { width: props.width, flexGrow: 0, flexShrink: 0 }),
        borderRadius: 10,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface0,
      }}
    >
      <View style={{ padding: 10, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tone }} />
          <Text style={{ flex: 1, color: colors.foreground, fontSize: 13, fontWeight: "600" }}>
            {column.label}
          </Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
            {props.groups[column.id].length}
          </Text>
        </View>
        <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11 }}>
          {column.hint}
        </Text>
      </View>
      <CardList {...props} column={column} />
    </View>
  );
}

/** Wide layout: all five columns in a horizontal scroller. */
export function WideColumns(props: CommonProps & { columnWidthPercent: number }) {
  const [containerWidth, setContainerWidth] = useState(0);
  const width = columnWidthFor(containerWidth, props.columnWidthPercent, COLUMNS.length);
  return (
    <ScrollView
      horizontal
      style={{ flex: 1 }}
      onLayout={function measure(event) {
        setContainerWidth(event.nativeEvent.layout.width);
      }}
      contentContainerStyle={{ flexGrow: 1, gap: BOARD_GAP, padding: BOARD_PADDING }}
    >
      {COLUMNS.map(function renderColumn(column) {
        return <BoardColumnView key={column.id} {...props} column={column} width={width} />;
      })}
    </ScrollView>
  );
}

/** Compact layout: one column fills the body. */
export function SingleColumn(props: CommonProps & { columnId: BoardColumn }) {
  const column = COLUMNS.find(function match(item) {
    return item.id === props.columnId;
  });
  if (!column) {
    return null;
  }
  return (
    <View style={{ flex: 1, paddingTop: 8 }}>
      <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 11, paddingHorizontal: 12, paddingBottom: 8 }}>
        {column.hint}
      </Text>
      <CardList {...props} column={column} />
    </View>
  );
}
