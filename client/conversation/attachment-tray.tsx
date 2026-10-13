/**
 * Selected-image tray above the input: 48x48 previews with a 24x24 surface2
 * remove button pinned to the top-left corner.
 */
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Image, Pressable, View } from "react-native";
import type { ComposerImage } from "./composer-images";
import type { ComposerPalette } from "./composer-tokens";

export function AttachmentTray(props: {
  palette: ComposerPalette;
  images: readonly ComposerImage[];
  onRemove(id: string): void;
}) {
  const { palette } = props;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 8, paddingLeft: 8 }}>
      {props.images.map(function renderImage(image) {
        return (
          <View key={image.id} style={{ width: 48, height: 48 }}>
            <Image
              source={{ uri: image.uri }}
              style={{
                width: 48,
                height: 48,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: palette.borderAccent,
              }}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="移除图片"
              onPress={function remove() {
                props.onRemove(image.id);
              }}
              style={{
                position: "absolute",
                top: -8,
                left: -8,
                width: 24,
                height: 24,
                borderRadius: 12,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: palette.surface2,
              }}
            >
              <Icon name="X" size={12} color={palette.foregroundMuted} />
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}
