/**
 * Self-drawn picker for a project chip that spans several Paseo workspaces:
 * each row jumps to its own workspace. Rendered as an absolute overlay;
 * `target` of null hides it.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import type { ProjectWorkspace } from "../shared/project-filter";
import { Chip } from "./badge";

export type WorkspacePickTarget = {
  projectLabel: string;
  workspaces: readonly ProjectWorkspace[];
};

type Props = {
  target: WorkspacePickTarget | null;
  theme: PluginTheme;
  onPick(workspaceId: string): void;
  onClose(): void;
};

export function WorkspacePicker(props: Props) {
  const { target, theme, onPick, onClose } = props;
  const { colors } = theme;
  if (target === null) {
    return null;
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
        accessibilityLabel="关闭工作区选择"
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
          width: 380,
          maxWidth: "92%",
          borderRadius: 12,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface0,
          padding: 14,
          gap: 10,
        }}
      >
        <View style={{ gap: 2 }}>
          <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "700" }}>打开工作区</Text>
          <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 12 }}>
            {`${target.projectLabel} 下有 ${target.workspaces.length} 个工作区`}
          </Text>
        </View>
        <View style={{ gap: 4 }}>
          {target.workspaces.map(function renderWorkspace(workspace) {
            return (
              <Pressable
                key={workspace.workspaceId}
                accessibilityRole="button"
                accessibilityLabel={`打开工作区 ${workspace.label}`}
                onPress={function pick() {
                  onPick(workspace.workspaceId);
                }}
                style={function rowStyle({ pressed }) {
                  return {
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    paddingHorizontal: 10,
                    paddingVertical: 8,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: colors.border,
                    backgroundColor: pressed ? colors.surface2 : colors.surface1,
                  };
                }}
              >
                <Icon name="FolderOpen" size={16} color={colors.foregroundMuted} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13 }}>
                    {workspace.label}
                  </Text>
                  <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                    {workspace.detail}
                  </Text>
                </View>
                <Icon name="ExternalLink" size={14} color={colors.foregroundMuted} />
              </Pressable>
            );
          })}
        </View>
        <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
          <Chip theme={theme} label="取消" selected={false} onPress={onClose} />
        </View>
      </View>
    </View>
  );
}
