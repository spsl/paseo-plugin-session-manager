/** Pure extraction of renderable permission requests (local structural types). */
import { stringifyForDisplay, toolSummary } from "./model";

export type PermissionRequestLike = {
  id: string;
  name?: string;
  kind?: string;
  title?: string;
  description?: string;
  input?: unknown;
  detail?: unknown;
  actions?: unknown;
};

export type PermissionChoice = {
  /** Sent back as selectedActionId; null for the implicit allow/deny pair. */
  actionId: string | null;
  label: string;
  behavior: "allow" | "deny";
  variant: "primary" | "secondary" | "danger";
};

export type PermissionView = {
  id: string;
  heading: string;
  body: string;
  choices: PermissionChoice[];
};

const KIND_LABELS: Record<string, string> = {
  tool: "工具调用",
  plan: "计划确认",
  question: "提问",
  mode: "模式切换",
  other: "权限请求",
};

export function extractChoices(actions: unknown): PermissionChoice[] {
  if (!Array.isArray(actions)) {
    return [];
  }
  const choices: PermissionChoice[] = [];
  for (const raw of actions) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const action = raw as Record<string, unknown>;
    if (typeof action.id !== "string" || (action.behavior !== "allow" && action.behavior !== "deny")) {
      continue;
    }
    const variant =
      action.variant === "primary" || action.variant === "danger" ? action.variant : "secondary";
    choices.push({
      actionId: action.id,
      label: typeof action.label === "string" && action.label !== "" ? action.label : action.id,
      behavior: action.behavior,
      variant,
    });
  }
  return choices;
}

export const DEFAULT_CHOICES: readonly PermissionChoice[] = [
  { actionId: null, label: "允许", behavior: "allow", variant: "primary" },
  { actionId: null, label: "拒绝", behavior: "deny", variant: "danger" },
];

export function permissionView(request: PermissionRequestLike): PermissionView {
  const kind = KIND_LABELS[request.kind ?? "other"] ?? "权限请求";
  const name = request.title || request.name || "";
  const heading = name ? `${kind} · ${name}` : kind;
  const summary = toolSummary(request.detail);
  const body =
    request.description ||
    summary ||
    (request.input === undefined ? "" : stringifyForDisplay(request.input, 600));
  const explicit = extractChoices(request.actions);
  return {
    id: request.id,
    heading,
    body,
    choices: explicit.length > 0 ? explicit : DEFAULT_CHOICES.slice(),
  };
}

export type PermissionResponseLike =
  | { behavior: "allow"; selectedActionId?: string }
  | { behavior: "deny"; selectedActionId?: string; message?: string };

export function responseFor(choice: PermissionChoice): PermissionResponseLike {
  if (choice.behavior === "allow") {
    return choice.actionId === null
      ? { behavior: "allow" }
      : { behavior: "allow", selectedActionId: choice.actionId };
  }
  return choice.actionId === null
    ? { behavior: "deny", message: "用户在会话看板中拒绝" }
    : { behavior: "deny", selectedActionId: choice.actionId };
}

export function visiblePermissions(
  requests: readonly PermissionRequestLike[],
  answered: ReadonlySet<string>,
): PermissionRequestLike[] {
  return requests.filter((request) => !answered.has(request.id));
}
