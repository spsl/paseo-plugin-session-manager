import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BoardScreen, bindSettingsOpener, SETTINGS_SCREEN_ID } from "./client/board-screen";
import { SessionManagerSettingsScreen } from "./client/settings-screen";
import {
  consumeBoardHandoff,
  NOTICE_NO_WINDOW,
  openBoardInNewWindow,
} from "./client/open-board-window";
import { isDesktop } from "./client/desktop-bridge";
import { BOARD_SCREEN_ID, BoardSidebarItem } from "./client/sidebar";

const BOARD_TITLE = "会话看板";

export default function contribute(client: PluginClientContext) {
  const cleanups: (() => void)[] = [];

  cleanups.push(client.addScreen({ id: BOARD_SCREEN_ID, title: BOARD_TITLE, Component: BoardScreen }));
  cleanups.push(
    client.addSidebarHeaderItem({ id: BOARD_SCREEN_ID, title: BOARD_TITLE, Component: BoardSidebarItem }),
  );
  // A screen cannot open settings itself, so the capability is lent to it here.
  bindSettingsOpener(function open(id) {
    client.openSettings(id);
  });
  cleanups.push(
    client.addSettingsScreen({
      id: SETTINGS_SCREEN_ID,
      title: BOARD_TITLE,
      icon: "Kanban",
      Component: SessionManagerSettingsScreen,
    }),
  );
  cleanups.push(
    client.addCommandCenterItem({
      id: "open-board",
      title: "打开会话看板",
      icon: "Kanban",
      keywords: ["看板", "会话", "session", "kanban", "board"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: BOARD_SCREEN_ID });
      },
    }),
  );
  if (isDesktop()) {
    cleanups.push(
      client.addCommandCenterItem({
        id: "open-board-window",
        title: "在新窗口打开会话看板",
        icon: "AppWindow",
        keywords: ["看板", "新窗口", "全屏", "window", "board", "fullscreen"],
        context: "global",
        onSelect({ openScreen }) {
          if (!openBoardInNewWindow()) {
            // Commands have no toast; the board shows the hint for this param.
            openScreen({ screenId: BOARD_SCREEN_ID, params: { notice: NOTICE_NO_WINDOW } });
          }
        },
      }),
    );
  }
  cleanups.push(
    client.addCommandCenterItem({
      id: "board-settings",
      title: "会话看板设置",
      icon: "Settings",
      keywords: ["看板", "设置", "分析器", "settings", "analyzer"],
      context: "global",
      onSelect({ openSettings }) {
        openSettings(SETTINGS_SCREEN_ID);
      },
    }),
  );

  consumeBoardHandoff(function openBoard(params) {
    client.openScreen({ screenId: BOARD_SCREEN_ID, params });
  });

  return function cleanup() {
    bindSettingsOpener(null);
    for (const remove of cleanups) {
      remove();
    }
  };
}
