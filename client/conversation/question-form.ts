/**
 * Question permissions (`kind: "question"`, e.g. Claude AskUserQuestion), ported
 * from Paseo's QuestionFormCard so the overlay answers exactly like the app:
 * answers keyed by header, sent as `updatedInput.answers`.
 */
import type { PermissionResponseLike } from "./permissions";

export type QuestionOption = { label: string; description?: string };

export type QuestionFormQuestion = {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowOther: boolean;
  allowEmpty: boolean;
  placeholder?: string;
  dismissLabel?: string;
};

/** Selected option indexes (in click order) and free-text answers, per question. */
export type QuestionFormState = {
  selections: Record<number, number[]>;
  texts: Record<number, string>;
  active: number;
};

export const EMPTY_QUESTION_FORM: QuestionFormState = { selections: {}, texts: {}, active: 0 };

export const QUESTION_LABELS = {
  submit: "提交",
  next: "下一步",
  dismiss: "关闭",
  answerPlaceholder: "输入你的回答...",
  otherPlaceholder: "其他...",
};

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** Null when the input is not a well-formed questions payload. */
export function parseQuestionFormQuestions(input: unknown): QuestionFormQuestion[] | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const raw = (input as Record<string, unknown>).questions;
  if (!Array.isArray(raw)) {
    return null;
  }
  const questions: QuestionFormQuestion[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      return null;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.question !== "string" || typeof record.header !== "string") {
      return null;
    }
    if (!Array.isArray(record.options)) {
      return null;
    }
    const options: QuestionOption[] = [];
    for (const rawOption of record.options) {
      if (typeof rawOption !== "object" || rawOption === null) {
        return null;
      }
      const option = rawOption as Record<string, unknown>;
      if (typeof option.label !== "string") {
        return null;
      }
      options.push(
        typeof option.description === "string"
          ? { label: option.label, description: option.description }
          : { label: option.label },
      );
    }
    questions.push({
      question: record.question,
      header: record.header,
      options,
      multiSelect: record.multiSelect === true,
      allowOther: record.allowOther === true || record.isOther === true,
      allowEmpty: record.allowEmpty === true,
      placeholder: optionalString(record, "placeholder"),
      dismissLabel: optionalString(record, "dismissLabel"),
    });
  }
  return questions.length > 0 ? questions : null;
}

export function questionShowsTextInput(question: QuestionFormQuestion): boolean {
  return question.options.length === 0 || question.allowOther;
}

export function questionPlaceholder(question: QuestionFormQuestion): string {
  if (question.placeholder !== undefined) {
    return question.placeholder;
  }
  return question.options.length === 0
    ? QUESTION_LABELS.answerPlaceholder
    : QUESTION_LABELS.otherPlaceholder;
}

export function isQuestionAnswered(
  question: QuestionFormQuestion,
  index: number,
  state: QuestionFormState,
): boolean {
  const selected = state.selections[index];
  if (selected !== undefined && selected.length > 0) {
    return true;
  }
  if (!questionShowsTextInput(question)) {
    return false;
  }
  const text = (state.texts[index] ?? "").trim();
  return text.length > 0 || question.allowEmpty;
}

export function areQuestionsAnswered(
  questions: readonly QuestionFormQuestion[],
  state: QuestionFormState,
): boolean {
  return questions.every(function answered(question, index) {
    return isQuestionAnswered(question, index, state);
  });
}

/** Clamped so a stale `active` never points past the last question. */
export function activeQuestionIndex(
  questions: readonly QuestionFormQuestion[],
  state: QuestionFormState,
): number {
  return Math.min(state.active, questions.length - 1);
}

/**
 * Single-select: picking toggles the option, clears the free text, and moves to
 * the next question. Multi-select only toggles.
 */
export function toggleQuestionOption(
  questions: readonly QuestionFormQuestion[],
  state: QuestionFormState,
  questionIndex: number,
  optionIndex: number,
): QuestionFormState {
  const multiSelect = questions[questionIndex]?.multiSelect ?? false;
  const current = state.selections[questionIndex] ?? [];
  const has = current.includes(optionIndex);
  let next: number[];
  if (multiSelect) {
    next = has
      ? current.filter(function keep(value) {
          return value !== optionIndex;
        })
      : [...current, optionIndex];
  } else {
    next = has ? [] : [optionIndex];
  }
  let texts = state.texts;
  if (!multiSelect && texts[questionIndex] !== undefined) {
    texts = { ...texts };
    delete texts[questionIndex];
  }
  const active =
    !multiSelect && next.length > 0 && questionIndex === state.active
      ? Math.min(questionIndex + 1, questions.length - 1)
      : state.active;
  return { selections: { ...state.selections, [questionIndex]: next }, texts, active };
}

/** Typing an answer to a single-select question drops the picked option. */
export function changeQuestionText(
  questions: readonly QuestionFormQuestion[],
  state: QuestionFormState,
  questionIndex: number,
  text: string,
): QuestionFormState {
  const multiSelect = questions[questionIndex]?.multiSelect ?? false;
  const selected = state.selections[questionIndex];
  const clear = !multiSelect && text.length > 0 && selected !== undefined && selected.length > 0;
  return {
    selections: clear ? { ...state.selections, [questionIndex]: [] } : state.selections,
    texts: { ...state.texts, [questionIndex]: text },
    active: state.active,
  };
}

/** Answers keyed by question header; free text wins over (or joins, for multi-select) options. */
export function buildQuestionFormAnswers(
  questions: readonly QuestionFormQuestion[],
  state: QuestionFormState,
): Record<string, string> {
  const answers: Record<string, string> = {};
  questions.forEach(function collect(question, index) {
    const text = (state.texts[index] ?? "").trim();
    const labels = (state.selections[index] ?? []).map(function label(optionIndex) {
      return question.options[optionIndex]?.label ?? "";
    });
    if (questionShowsTextInput(question)) {
      if (text.length > 0) {
        answers[question.header] = question.multiSelect ? [...labels, text].join(", ") : text;
        return;
      }
      if (question.allowEmpty && question.options.length === 0) {
        answers[question.header] = "";
        return;
      }
    }
    if (labels.length > 0) {
      answers[question.header] = labels.join(", ");
    }
  });
  return answers;
}

export function shouldSubmitEmptyOnDismiss(questions: readonly QuestionFormQuestion[]): boolean {
  return (
    questions.length > 0 &&
    questions.every(function emptyAllowed(question) {
      return question.allowEmpty && question.options.length === 0;
    })
  );
}

export function resolveDismissLabel(questions: readonly QuestionFormQuestion[]): string {
  const found = questions.find(function hasLabel(question) {
    return question.dismissLabel !== undefined && question.dismissLabel !== "";
  });
  return found?.dismissLabel ?? QUESTION_LABELS.dismiss;
}

function inputRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

export function questionSubmitResponse(
  input: unknown,
  questions: readonly QuestionFormQuestion[],
  state: QuestionFormState,
): PermissionResponseLike {
  return {
    behavior: "allow",
    updatedInput: { ...inputRecord(input), answers: buildQuestionFormAnswers(questions, state) },
  };
}

export function questionDismissResponse(
  input: unknown,
  questions: readonly QuestionFormQuestion[],
  state: QuestionFormState,
): PermissionResponseLike {
  return shouldSubmitEmptyOnDismiss(questions)
    ? questionSubmitResponse(input, questions, state)
    : { behavior: "deny", message: "Dismissed by user" };
}
