/**
 * The card this plugin puts in an agent's own transcript. The daemon appends it
 * (`server/cards.ts`), the app draws it (`client/timeline-card.tsx`); this
 * kind/version pair and schema are the only thing tying the two together.
 * Everything the card shows is precomputed here so the renderer stays dumb.
 *
 * Client-reachable (Hermes): no async arrows, no closures inside for...of.
 */
import { z } from "zod";
import { analysisStatusLabel } from "./presentation";
import {
  speechOf,
  statusForDeclared,
  type Analysis,
  type AnalysisStatus,
  type Declared,
} from "./types";

export const SESSION_CARD_KIND = "session-manager-card";
export const SESSION_CARD_VERSION = 1;

export const CARD_TONES = ["success", "warning", "danger", "info", "muted"] as const;
export type CardTone = (typeof CARD_TONES)[number];

export const CARD_STATES = [
  "pending",
  "ready",
  "failed",
  "superseded",
  "waiting",
  "resolved",
] as const;

export const SessionCardSchema = z.object({
  variant: z.enum(["turn", "permission"]),
  state: z.enum(CARD_STATES),
  tone: z.enum(CARD_TONES),
  /** Header suffix after 「会话看板 · 」. */
  label: z.string(),
  /** The italic sentence (turn) or request title (permission). */
  text: z.string().nullable(),
  nextStep: z.string().nullable(),
  /** Request description for permission cards. */
  detail: z.string().nullable(),
  choices: z.array(z.string()).default([]),
  /** What the play button speaks; null hides the button. */
  speak: z.string().nullable(),
});
export type SessionCard = z.infer<typeof SessionCardSchema>;

const ERROR_MAX = 80;
const DETAIL_MAX = 300;
const CHOICE_MAX = 6;

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function shortError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return clip(oneLine(raw), ERROR_MAX) || "未知错误";
}

export function statusTone(status: AnalysisStatus): CardTone {
  switch (status) {
    case "completed":
      return "success";
    case "waiting_for_user":
      return "warning";
    case "blocked":
      return "danger";
    case "in_progress":
      return "info";
    case "unclear":
      return "muted";
  }
}

export function pendingTurnCard(): SessionCard {
  return {
    variant: "turn",
    state: "pending",
    tone: "muted",
    label: "分析中",
    text: "正在分析…",
    nextStep: null,
    detail: null,
    choices: [],
    speak: null,
  };
}

/** The agent's own declared result, when present, sets the card's status. */
export function readyTurnCard(analysis: Analysis, declared: Declared | null = null): SessionCard {
  const text = speechOf(analysis);
  const next = analysis.nextSteps.length > 0 ? oneLine(analysis.nextSteps[0]) : "";
  const status = declared ? statusForDeclared(declared.kind) : analysis.status;
  return {
    variant: "turn",
    state: "ready",
    tone: statusTone(status),
    label: analysisStatusLabel(status),
    text,
    nextStep: next === "" ? null : next,
    detail: null,
    choices: [],
    speak: text === "" ? null : text,
  };
}

export function failedTurnCard(error: unknown): SessionCard {
  return {
    variant: "turn",
    state: "failed",
    tone: "danger",
    label: "分析失败",
    text: `分析失败：${shortError(error)}`,
    nextStep: null,
    detail: null,
    choices: [],
    speak: null,
  };
}

export function supersededTurnCard(): SessionCard {
  return {
    variant: "turn",
    state: "superseded",
    tone: "muted",
    label: "已过期",
    text: "已被新一轮取代",
    nextStep: null,
    detail: null,
    choices: [],
    speak: null,
  };
}

export type PermissionRequestInfo = {
  id: string;
  name?: string;
  kind?: string;
  title?: string;
  description?: string;
  input?: unknown;
  actions?: unknown;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function labelOf(value: unknown): string | null {
  if (typeof value === "string") {
    return oneLine(value) || null;
  }
  const record = asObject(value);
  if (record && typeof record.label === "string") {
    return oneLine(record.label) || null;
  }
  return null;
}

/** The first question and its option labels from a question-kind request's input, if present. */
function questionFromInput(input: unknown): { question: string | null; options: string[] } {
  const record = asObject(input);
  const questions = record && Array.isArray(record.questions) ? record.questions : null;
  const first = questions && questions.length > 0 ? asObject(questions[0]) : null;
  if (!first) {
    return { question: null, options: [] };
  }
  const question = typeof first.question === "string" ? oneLine(first.question) : null;
  const options: string[] = [];
  if (Array.isArray(first.options)) {
    for (const option of first.options) {
      const label = labelOf(option);
      if (label) {
        options.push(label);
      }
    }
  }
  return { question: question || null, options };
}

function actionLabels(actions: unknown): string[] {
  const labels: string[] = [];
  if (!Array.isArray(actions)) {
    return labels;
  }
  for (const action of actions) {
    const label = labelOf(action);
    if (label) {
      labels.push(label);
    }
  }
  return labels;
}

export function isQuestionRequest(request: PermissionRequestInfo): boolean {
  return request.kind === "question";
}

/** The one line naming what a permission/question asks, with the question text when known. */
export function requestHeadline(request: PermissionRequestInfo): string {
  if (isQuestionRequest(request)) {
    const fromInput = questionFromInput(request.input).question;
    if (fromInput) {
      return clip(fromInput, 160);
    }
  }
  const title = oneLine(request.title ?? "") || oneLine(request.name ?? "");
  return clip(title, 160);
}

export function permissionCard(request: PermissionRequestInfo): SessionCard {
  const question = isQuestionRequest(request);
  const fromInput = question ? questionFromInput(request.input) : { question: null, options: [] };
  const optionList = fromInput.options.length > 0 ? fromInput.options : actionLabels(request.actions);
  const description = oneLine(request.description ?? "");
  const headline = requestHeadline(request);
  return {
    variant: "permission",
    state: "waiting",
    tone: "warning",
    label: question ? "等待回答" : "等待授权",
    text: headline === "" ? null : headline,
    nextStep: null,
    detail: description === "" || description === headline ? null : clip(description, DETAIL_MAX),
    choices: optionList.slice(0, CHOICE_MAX),
    speak: null,
  };
}

/** The same card after the request was answered: muted, no longer waiting. */
export function resolvedPermissionCard(
  previous: SessionCard,
  behavior: "allow" | "deny" | string,
): SessionCard {
  const question = previous.label === "等待回答";
  const label = behavior === "deny" ? "已拒绝" : question ? "已回答" : "已允许";
  return {
    ...previous,
    state: "resolved",
    tone: "muted",
    label,
    choices: [],
    speak: null,
  };
}

/** What a permission/question announcement says. */
export function permissionSpeech(name: string, request: PermissionRequestInfo): string {
  const headline = requestHeadline(request);
  if (isQuestionRequest(request)) {
    const options = questionFromInput(request.input).options;
    const choices = options.length > 0 ? `，选项：${options.slice(0, 4).join("、")}` : "";
    return clip(`${name}：${headline || "有一个问题等待回答"}${choices}`, 200);
  }
  return clip(`${name}：等待授权${headline ? `：${headline}` : ""}`, 200);
}

/** The name a session is announced by: its own title, else the analysis title, else the folder. */
export function sessionDisplayName(input: {
  agentTitle: string | null;
  analysisTitle?: string | null;
  cwd: string;
}): string {
  const title = oneLine(input.agentTitle ?? "") || oneLine(input.analysisTitle ?? "");
  if (title) {
    return title;
  }
  const parts = input.cwd.split("/").filter(function nonEmpty(part) {
    return part !== "";
  });
  return parts.length > 0 ? parts[parts.length - 1] : "会话";
}
