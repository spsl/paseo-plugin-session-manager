/** Question permission form, laid out like Paseo's own QuestionFormCard. */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PermissionResponseLike } from "./permissions";
import {
  EMPTY_QUESTION_FORM,
  QUESTION_LABELS,
  activeQuestionIndex,
  areQuestionsAnswered,
  changeQuestionText,
  isQuestionAnswered,
  questionDismissResponse,
  questionPlaceholder,
  questionShowsTextInput,
  questionSubmitResponse,
  resolveDismissLabel,
  toggleQuestionOption,
  type QuestionFormQuestion,
  type QuestionFormState,
} from "./question-form";

export function QuestionFormCard(props: {
  theme: PluginTheme;
  input: unknown;
  questions: QuestionFormQuestion[];
  busy: boolean;
  compact: boolean;
  onRespond(response: PermissionResponseLike): void;
}) {
  const { colors } = props.theme;
  const { questions, busy } = props;
  const [form, setForm] = useState<QuestionFormState>(EMPTY_QUESTION_FORM);

  const index = activeQuestionIndex(questions, form);
  const question = questions[index]!;
  const isLast = index === questions.length - 1;
  const allAnswered = areQuestionsAnswered(questions, form);
  const currentAnswered = isQuestionAnswered(question, index, form);
  const primaryDisabled = busy || (isLast ? !allAnswered : !currentAnswered);
  const selected = form.selections[index] ?? [];
  const text = form.texts[index] ?? "";
  const dismissLabel = resolveDismissLabel(questions);

  function primary(): void {
    if (isLast) {
      if (allAnswered && !busy) {
        props.onRespond(questionSubmitResponse(props.input, questions, form));
      }
      return;
    }
    if (!currentAnswered || busy) {
      return;
    }
    setForm(function advance(current) {
      return { ...current, active: Math.min(current.active + 1, questions.length - 1) };
    });
  }

  function dismiss(): void {
    props.onRespond(questionDismissResponse(props.input, questions, form));
  }

  return (
    <View
      style={{
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
        gap: 12,
      }}
    >
      {questions.length > 1 ? (
        <View
          accessibilityRole="tablist"
          style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4, paddingHorizontal: 12 }}
        >
          {questions.map(function renderTab(item, tabIndex) {
            const active = tabIndex === index;
            const answered = isQuestionAnswered(item, tabIndex, form);
            const tint = active ? colors.foreground : colors.foregroundMuted;
            return (
              <Pressable
                key={`${item.header}-${tabIndex}`}
                accessibilityRole="tab"
                accessibilityLabel={`第 ${tabIndex + 1} 个问题，共 ${questions.length} 个`}
                accessibilityState={{ selected: active }}
                disabled={busy}
                onPress={function select() {
                  setForm(function focus(current) {
                    return { ...current, active: tabIndex };
                  });
                }}
                style={function tabStyle({ pressed }) {
                  return {
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                    minHeight: 28,
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                    borderRadius: 6,
                    borderWidth: 1,
                    borderColor: active ? colors.foregroundMuted : colors.border,
                    backgroundColor: active ? colors.surface2 : colors.surface1,
                    opacity: pressed ? 0.9 : 1,
                  };
                }}
              >
                {answered ? <Icon name="Check" size={12} color={tint} /> : null}
                <Text numberOfLines={1} style={{ color: tint, fontSize: 14 }}>
                  {item.header}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <View style={{ paddingHorizontal: 12, paddingBottom: 4 }}>
        <Text selectable style={{ color: colors.foreground, fontSize: 14, lineHeight: 22 }}>
          {question.question}
        </Text>
      </View>

      <View key={`${question.header}-${index}`} style={{ gap: 8 }}>
        {question.options.length > 0 ? (
          <View
            accessibilityRole={question.multiSelect ? undefined : "radiogroup"}
            accessibilityLabel={question.multiSelect ? undefined : question.question}
            style={{ gap: 4 }}
          >
            {question.options.map(function renderOption(option, optionIndex) {
              const checked = selected.includes(optionIndex);
              return (
                <Pressable
                  key={`${option.label}-${optionIndex}`}
                  accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
                  accessibilityLabel={option.label}
                  accessibilityState={{ checked }}
                  disabled={busy}
                  onPress={function toggle() {
                    setForm(function pick(current) {
                      return toggleQuestionOption(questions, current, index, optionIndex);
                    });
                  }}
                  style={function optionStyle({ pressed }) {
                    return {
                      flexDirection: "row",
                      alignItems: "center",
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                      borderRadius: 6,
                      backgroundColor: checked ? colors.surface2 : "transparent",
                      opacity: pressed ? 0.9 : 1,
                    };
                  }}
                >
                  <View style={{ flex: 1, flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
                    <View
                      style={{
                        width: 18,
                        height: 18,
                        marginTop: 2,
                        alignItems: "center",
                        justifyContent: "center",
                        borderWidth: 1,
                        borderRadius: question.multiSelect ? 4 : 999,
                        borderColor: checked ? colors.accent : colors.foregroundMuted,
                        backgroundColor: checked && question.multiSelect ? colors.accent : "transparent",
                      }}
                    >
                      {checked && question.multiSelect ? (
                        <Icon name="Check" size={12} color={colors.accentForeground} />
                      ) : null}
                      {checked && !question.multiSelect ? (
                        <View style={{ width: 8, height: 8, borderRadius: 999, backgroundColor: colors.accent }} />
                      ) : null}
                    </View>
                    <View style={{ flex: 1, gap: 4 }}>
                      <Text
                        style={{
                          color: checked ? colors.foreground : colors.foregroundMuted,
                          fontSize: 14,
                          lineHeight: 22,
                        }}
                      >
                        {option.label}
                      </Text>
                      {option.description ? (
                        <Text style={{ color: colors.foregroundMuted, fontSize: 14, lineHeight: 20 }}>
                          {option.description}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        {questionShowsTextInput(question) ? (
          <TextInput
            value={text}
            onChangeText={function onChangeText(value) {
              setForm(function type(current) {
                return changeQuestionText(questions, current, index, value);
              });
            }}
            onSubmitEditing={primary}
            submitBehavior="submit"
            editable={!busy}
            accessibilityLabel={question.question}
            placeholder={questionPlaceholder(question)}
            placeholderTextColor={colors.foregroundMuted}
            style={{
              borderWidth: 1,
              borderRadius: 8,
              borderColor: text.length > 0 ? colors.foregroundMuted : colors.border,
              backgroundColor: colors.surface2,
              color: colors.foreground,
              paddingHorizontal: 12,
              paddingVertical: 12,
              fontSize: 14,
            }}
          />
        ) : null}
      </View>

      <View
        style={
          props.compact
            ? { gap: 8 }
            : { gap: 8, flexDirection: "row", justifyContent: "flex-start", alignItems: "center" }
        }
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={dismissLabel}
          disabled={busy}
          onPress={dismiss}
          style={function dismissStyle({ pressed }) {
            return {
              paddingVertical: 8,
              paddingHorizontal: 12,
              borderRadius: 6,
              borderWidth: 1,
              alignItems: "center",
              borderColor: colors.border,
              backgroundColor: pressed ? colors.surface2 : colors.surface1,
              opacity: busy ? 0.5 : 1,
            };
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Icon name="X" size={14} color={colors.foregroundMuted} />
            <Text style={{ color: colors.foregroundMuted, fontSize: 14 }}>{dismissLabel}</Text>
          </View>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isLast ? QUESTION_LABELS.submit : QUESTION_LABELS.next}
          disabled={primaryDisabled}
          onPress={primary}
          style={function primaryStyle({ pressed }) {
            return {
              paddingVertical: 8,
              paddingHorizontal: 12,
              borderRadius: 6,
              borderWidth: 1,
              alignItems: "center",
              borderColor: colors.accent,
              backgroundColor: colors.accent,
              opacity: primaryDisabled ? 0.5 : pressed ? 0.9 : 1,
            };
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Icon name="Check" size={14} color={colors.accentForeground} />
            <Text style={{ color: colors.accentForeground, fontSize: 14 }}>
              {isLast ? QUESTION_LABELS.submit : QUESTION_LABELS.next}
            </Text>
          </View>
        </Pressable>
      </View>
    </View>
  );
}
