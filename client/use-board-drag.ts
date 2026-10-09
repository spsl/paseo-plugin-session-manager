/**
 * Pure React Native drag-and-drop for the board.
 *
 * A long press on a card starts a drag: every column and the card are measured
 * (measureInWindow), then a root PanResponder captures moves while dragging and
 * moves an Animated ghost. React state changes only when the hovered column
 * changes, so the card lists do not re-render during moves.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Animated,
  PanResponder,
  type GestureResponderEvent,
  type View,
} from "react-native";
import { hitTestColumn, type ColumnRect } from "../shared/drop-target";
import { BOARD_COLUMNS, type AnalysisStatus, type BoardColumn, type SessionView } from "../shared/types";
import { resolveDrop } from "./drag-logic";

export type ActiveDrag = { session: SessionView; width: number; height: number };

type DragRecord = {
  session: SessionView;
  grabX: number;
  grabY: number;
  rects: ColumnRect[];
  moved: boolean;
  hover: BoardColumn | null;
  lastX: number;
  lastY: number;
};

export type BoardDragOptions = {
  enabled: boolean;
  onDrop(session: SessionView, status: AnalysisStatus): void;
  onReject(message: string): void;
};

export function useBoardDrag(options: BoardDragOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const dragRef = useRef<DragRecord | null>(null);
  const columnViews = useRef(new Map<BoardColumn, View>());
  const rootRef = useRef<View | null>(null);
  const rootOrigin = useRef({ x: 0, y: 0 });
  const ghost = useRef(new Animated.ValueXY()).current;
  const [active, setActive] = useState<ActiveDrag | null>(null);
  const [hover, setHover] = useState<BoardColumn | null>(null);

  const registerColumn = useCallback(function registerColumn(id: BoardColumn, view: View | null) {
    if (view) {
      columnViews.current.set(id, view);
    } else {
      columnViews.current.delete(id);
    }
  }, []);

  const finish = useCallback(function finish(drop: boolean) {
    const record = dragRef.current;
    dragRef.current = null;
    setActive(null);
    setHover(null);
    if (!record || !drop || !record.moved) {
      return;
    }
    const target = hitTestColumn(record.rects, record.lastX, record.lastY);
    const resolution = resolveDrop(record.session, target);
    if (resolution.kind === "drop") {
      optionsRef.current.onDrop(record.session, resolution.status);
    } else if (resolution.kind === "reject") {
      optionsRef.current.onReject(resolution.message);
    }
  }, []);

  const track = useCallback(
    function track(x: number, y: number) {
      const record = dragRef.current;
      if (!record) {
        return;
      }
      record.lastX = x;
      record.lastY = y;
      ghost.setValue({
        x: x - record.grabX - rootOrigin.current.x,
        y: y - record.grabY - rootOrigin.current.y,
      });
      const hit = hitTestColumn(record.rects, x, y);
      if (hit !== record.hover) {
        record.hover = hit;
        setHover(hit);
      }
    },
    [ghost],
  );

  const startDrag = useCallback(
    function startDrag(session: SessionView, card: View | null, event: GestureResponderEvent) {
      if (!optionsRef.current.enabled || dragRef.current !== null || card === null) {
        return;
      }
      const touchX = event.nativeEvent.pageX;
      const touchY = event.nativeEvent.pageY;
      const record: DragRecord = {
        session,
        grabX: 0,
        grabY: 0,
        rects: [],
        moved: false,
        hover: null,
        lastX: touchX,
        lastY: touchY,
      };
      dragRef.current = record;

      const root = rootRef.current;
      if (root) {
        root.measureInWindow(function onRoot(x, y) {
          rootOrigin.current = { x, y };
        });
      }
      BOARD_COLUMNS.forEach(function measureColumn(id) {
        const view = columnViews.current.get(id);
        if (!view) {
          return;
        }
        view.measureInWindow(function onColumn(x, y, width, height) {
          if (dragRef.current === record) {
            record.rects.push({ id, x, y, width, height });
          }
        });
      });
      card.measureInWindow(function onCard(x, y, width, height) {
        if (dragRef.current !== record) {
          return;
        }
        const hasTouch = Number.isFinite(touchX) && Number.isFinite(touchY);
        record.grabX = hasTouch ? touchX - x : width / 2;
        record.grabY = hasTouch ? touchY - y : height / 2;
        if (!hasTouch) {
          record.lastX = x + width / 2;
          record.lastY = y + height / 2;
        }
        ghost.setValue({
          x: x - rootOrigin.current.x,
          y: y - rootOrigin.current.y,
        });
        setActive({ session, width, height });
      });
    },
    [ghost],
  );

  /** Releasing a long press without moving cancels the drag. */
  const onCardPressOut = useCallback(
    function onCardPressOut() {
      const record = dragRef.current;
      if (record && !record.moved) {
        finish(false);
      }
    },
    [finish],
  );

  const panHandlers = useMemo(
    function createPanResponder() {
      return PanResponder.create({
        onStartShouldSetPanResponder: function never() {
          return false;
        },
        onMoveShouldSetPanResponder: function never() {
          return false;
        },
        onMoveShouldSetPanResponderCapture: function capture() {
          const record = dragRef.current;
          if (record === null) {
            return false;
          }
          record.moved = true;
          return true;
        },
        onPanResponderTerminationRequest: function refuse() {
          return false;
        },
        onPanResponderGrant: function granted(_event, gesture) {
          track(gesture.moveX, gesture.moveY);
        },
        onPanResponderMove: function moved(_event, gesture) {
          track(gesture.moveX, gesture.moveY);
        },
        onPanResponderRelease: function released() {
          finish(true);
        },
        onPanResponderTerminate: function terminated() {
          finish(false);
        },
      }).panHandlers;
    },
    [track, finish],
  );

  return {
    active,
    hover,
    ghost,
    rootRef,
    panHandlers,
    registerColumn,
    startDrag,
    onCardPressOut,
    scrollEnabled: active === null,
  };
}

export type BoardDrag = ReturnType<typeof useBoardDrag>;
