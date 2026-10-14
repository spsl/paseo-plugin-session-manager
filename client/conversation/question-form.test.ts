import { describe, expect, it } from "vitest";
import {
  EMPTY_QUESTION_FORM,
  areQuestionsAnswered,
  buildQuestionFormAnswers,
  changeQuestionText,
  isQuestionAnswered,
  parseQuestionFormQuestions,
  questionDismissResponse,
  questionPlaceholder,
  questionSubmitResponse,
  resolveDismissLabel,
  toggleQuestionOption,
  type QuestionFormQuestion,
} from "./question-form";

const input = {
  questions: [
    {
      question: "Q1：要不要一起处理？",
      header: "Q1 范围",
      allowOther: true,
      multiSelect: false,
      options: [
        { label: "A：本次不动", description: "与 master 保持一致" },
        { label: "B：本次顺带改" },
      ],
    },
    {
      question: "Q2：要提交吗？",
      header: "Q2 提交",
      multiSelect: true,
      options: [{ label: "提交" }, { label: "推送" }],
    },
  ],
};

function parsed(): QuestionFormQuestion[] {
  return parseQuestionFormQuestions(input)!;
}

describe("parseQuestionFormQuestions", () => {
  it("reads questions, options and flags", () => {
    const questions = parsed();
    expect(questions).toHaveLength(2);
    expect(questions[0]).toMatchObject({
      header: "Q1 范围",
      allowOther: true,
      multiSelect: false,
      options: [{ label: "A：本次不动", description: "与 master 保持一致" }, { label: "B：本次顺带改" }],
    });
    expect(questions[1]).toMatchObject({ multiSelect: true, allowOther: false });
  });

  it("rejects malformed payloads", () => {
    expect(parseQuestionFormQuestions(null)).toBeNull();
    expect(parseQuestionFormQuestions({ questions: [] })).toBeNull();
    expect(parseQuestionFormQuestions({ questions: [{ question: "q", options: [] }] })).toBeNull();
    expect(parseQuestionFormQuestions({ questions: [{ question: "q", header: "h", options: [{}] }] })).toBeNull();
  });
});

describe("question form state", () => {
  it("single-select picks one option and advances to the next question", () => {
    const questions = parsed();
    const state = toggleQuestionOption(questions, EMPTY_QUESTION_FORM, 0, 1);
    expect(state.selections[0]).toEqual([1]);
    expect(state.active).toBe(1);
    expect(isQuestionAnswered(questions[0]!, 0, state)).toBe(true);
    expect(toggleQuestionOption(questions, { ...state, active: 0 }, 0, 1).selections[0]).toEqual([]);
  });

  it("multi-select toggles without advancing", () => {
    const questions = parsed();
    let state = { ...EMPTY_QUESTION_FORM, active: 1 };
    state = toggleQuestionOption(questions, state, 1, 1);
    state = toggleQuestionOption(questions, state, 1, 0);
    expect(state.selections[1]).toEqual([1, 0]);
    expect(state.active).toBe(1);
    expect(toggleQuestionOption(questions, state, 1, 1).selections[1]).toEqual([0]);
  });

  it("typing clears a single-select option and picking clears the text", () => {
    const questions = parsed();
    let state = toggleQuestionOption(questions, EMPTY_QUESTION_FORM, 0, 0);
    state = changeQuestionText(questions, state, 0, "自定义");
    expect(state.selections[0]).toEqual([]);
    expect(state.texts[0]).toBe("自定义");
    expect(isQuestionAnswered(questions[0]!, 0, state)).toBe(true);
    state = toggleQuestionOption(questions, { ...state, active: 0 }, 0, 1);
    expect(state.texts[0]).toBeUndefined();
  });

  it("only questions with a text input accept a typed answer", () => {
    const questions = parsed();
    const state = changeQuestionText(questions, EMPTY_QUESTION_FORM, 1, "随便");
    expect(isQuestionAnswered(questions[1]!, 1, state)).toBe(false);
    expect(areQuestionsAnswered(questions, state)).toBe(false);
  });
});

describe("question responses", () => {
  it("submits answers keyed by header inside updatedInput", () => {
    const questions = parsed();
    let state = changeQuestionText(questions, EMPTY_QUESTION_FORM, 0, "  先不动  ");
    state = toggleQuestionOption(questions, state, 1, 0);
    state = toggleQuestionOption(questions, state, 1, 1);
    expect(areQuestionsAnswered(questions, state)).toBe(true);
    expect(buildQuestionFormAnswers(questions, state)).toEqual({ "Q1 范围": "先不动", "Q2 提交": "提交, 推送" });
    expect(questionSubmitResponse(input, questions, state)).toEqual({
      behavior: "allow",
      updatedInput: { ...input, answers: { "Q1 范围": "先不动", "Q2 提交": "提交, 推送" } },
    });
  });

  it("dismiss denies unless every question is an optional free-text one", () => {
    const questions = parsed();
    expect(questionDismissResponse(input, questions, EMPTY_QUESTION_FORM)).toEqual({
      behavior: "deny",
      message: "Dismissed by user",
    });
    const freeText = { questions: [{ question: "备注？", header: "备注", options: [], allowEmpty: true }] };
    const optional = parseQuestionFormQuestions(freeText)!;
    expect(questionDismissResponse(freeText, optional, EMPTY_QUESTION_FORM)).toEqual({
      behavior: "allow",
      updatedInput: { ...freeText, answers: { 备注: "" } },
    });
  });

  it("labels follow the question overrides", () => {
    const questions = parsed();
    expect(resolveDismissLabel(questions)).toBe("关闭");
    expect(questionPlaceholder(questions[0]!)).toBe("其他...");
    const custom = parseQuestionFormQuestions({
      questions: [{ question: "q", header: "h", options: [], dismissLabel: "跳过", placeholder: "写点什么" }],
    })!;
    expect(resolveDismissLabel(custom)).toBe("跳过");
    expect(questionPlaceholder(custom[0]!)).toBe("写点什么");
  });
});
