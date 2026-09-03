import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const AGENT_PROFILES = {
  explorer: {
    tools: "read,grep,find,ls",
    thinking: "medium",
    instruction:
      "Explore the codebase and gather relevant facts. Do not modify files.",
  },
  reviewer: {
    tools: "read,grep,find,ls",
    thinking: "xhigh",
    instruction:
      "Review the requested code or change for correctness, risks, and missing tests. Do not modify files.",
  },
  work: {
    tools: "read,grep,find,ls,write,edit,bash",
    thinking: "medium",
    instruction:
      "Implement the requested changes, run relevant checks, and report what changed.",
  },
} as const;

type AgentMode = keyof typeof AGENT_PROFILES;

const MAX_OUTPUT_CHARS = 50_000;
const MAX_OUTPUT_LINES = 2_000;
const MAX_LIVE_TEXT_CHARS = 8_000;
const MAX_TOOL_OUTPUT_CHARS = 4_000;
const MAX_ACTIVITY = 20;
const MAX_STDERR_CHARS = 20_000;
const MAX_BUFFER_CHARS = 1_000_000;
const MAX_PROMPT_CHARS = 20_000;

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;

  // Pi's usage.totalTokens for the latest assistant turn.
  contextTokens: number;

  turns: number;
}

interface AgentDetails {
  mode: AgentMode;

  status: "starting" | "running" | "done" | "error" | "aborted";

  model: string;
  thinking: string;
  cwd: string;

  usage: UsageStats;

  activity: string[];

  // Most recently completed assistant response.
  liveText: string;

  // Last completed assistant response.
  finalText: string;

  // Most recently completed tool output.
  toolOutput?: string;

  stopReason?: string;
  exitCode?: number;
}

function truncateTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `…${text.slice(-(maxChars - 1))}`;
}

function truncateOutput(text: string): string {
  let truncated = false;
  let lines = text.split("\n");

  if (lines.length > MAX_OUTPUT_LINES) {
    lines = lines.slice(0, MAX_OUTPUT_LINES);
    truncated = true;
  }

  let output = lines.join("\n");

  if (output.length > MAX_OUTPUT_CHARS) {
    output = output.slice(0, MAX_OUTPUT_CHARS);
    truncated = true;
  }

  return truncated ? `${output}\n\n[Subagent output truncated]` : output;
}

function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatUsage(usage: UsageStats): string {
  const parts = [
    `${usage.turns} turn${usage.turns === 1 ? "" : "s"}`,
    `in ${formatTokens(usage.input)}`,
    `out ${formatTokens(usage.output)}`,
    `cache-hit ${formatTokens(usage.cacheRead)}`,
    `cache-write ${formatTokens(usage.cacheWrite)}`,
  ];

  if (usage.contextTokens) {
    parts.push(`ctx ${formatTokens(usage.contextTokens)}`);
  }

  if (usage.cost) {
    parts.push(`$${usage.cost.toFixed(4)}`);
  }

  return parts.join(" · ");
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part: any) => {
      if (part?.type === "text" && typeof part.text === "string") {
        return part.text;
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function assistantText(message: any): string {
  if (!message || message.role !== "assistant") {
    return "";
  }

  return contentToText(message.content);
}

function toolResultText(result: any): string {
  if (!result) return "";

  if (typeof result === "string") {
    return result;
  }

  if (result.content) {
    return contentToText(result.content);
  }

  if (typeof result.output === "string") {
    return result.output;
  }

  return "";
}

function addActivity(details: AgentDetails, text: string) {
  // Avoid duplicate consecutive events when Pi emits both
  // tool_execution_* and message/tool_result events.
  if (details.activity[details.activity.length - 1] === text) {
    return;
  }

  details.activity.push(text);

  if (details.activity.length > MAX_ACTIVITY) {
    details.activity.splice(0, details.activity.length - MAX_ACTIVITY);
  }
}

function formatToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
): string {
  const a = args ?? {};

  switch (name) {
    case "bash":
      return `$ ${truncateTail(String(a.command ?? "..."), 160)}`;

    case "read":
      return `read ${String(a.path ?? a.file_path ?? "...")}`;

    case "write":
      return `write ${String(a.path ?? a.file_path ?? "...")}`;

    case "edit":
      return `edit ${String(a.path ?? a.file_path ?? "...")}`;

    case "grep":
      return `grep /${String(a.pattern ?? "")}/ ${String(a.path ?? ".")}`;

    case "find":
      return `find ${String(a.pattern ?? "*")} ${String(a.path ?? ".")}`;

    case "ls":
      return `ls ${String(a.path ?? ".")}`;

    default:
      return `${name} ${truncateTail(JSON.stringify(a), 160)}`;
  }
}

/**
 * Full renderer used after execution finishes.
 */
function renderDetails(details: AgentDetails, expanded: boolean): string {
  const icon =
    details.status === "done"
      ? "✓"
      : details.status === "error"
        ? "✗"
        : details.status === "aborted"
          ? "✗"
          : "⏳";

  const lines: string[] = [];

  lines.push(`${icon} agent ${details.mode} · ${details.status}`);

  lines.push(`model ${details.model} · thinking ${details.thinking}`);

  lines.push(formatUsage(details.usage));

  const activityLimit = expanded ? MAX_ACTIVITY : 8;
  const activity = details.activity.slice(-activityLimit);

  if (activity.length) {
    lines.push("");

    for (const item of activity) {
      lines.push(`→ ${item}`);
    }
  }

  if (details.toolOutput) {
    lines.push("");
    lines.push("tool output:");

    const output = expanded
      ? details.toolOutput
      : details.toolOutput.split("\n").slice(-8).join("\n");

    lines.push(output);
  }

  const assistant = details.finalText || details.liveText;

  if (assistant) {
    lines.push("");
    lines.push("assistant:");

    if (expanded) {
      lines.push(assistant);
    } else {
      lines.push(truncateTail(assistant, MAX_LIVE_TEXT_CHARS));
    }
  }

  return lines.join("\n");
}

/**
 * Fixed-height renderer used while the child is running.
 *
 * Keeping this at exactly four lines prevents Pi's TUI from
 * constantly growing/shrinking the tool block and moving the
 * terminal cursor around.
 */
function renderPartialDetails(details: AgentDetails): string {
  const currentActivity =
    details.activity[details.activity.length - 1] ?? "waiting for agent";

  return [
    `⏳ agent ${details.mode} · ${details.status}`,
    `${details.model} · thinking ${details.thinking}`,
    formatUsage(details.usage),
    `→ ${truncateTail(currentActivity, 180)}`,
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "agent",
    label: "Agent",

    description: "Run an isolated Pi subagent.",

    promptSnippet: "Run a subagent",

    promptGuidelines: [
      "Use explorer for codebase discovery, reviewer for deep read-only review, and work for edits.",
      "The child inherits the parent model; explorer uses medium, reviewer xhigh, and work high thinking.",
      "Verify important subagent conclusions.",
    ],

    parameters: Type.Object({
      mode: StringEnum(["explorer", "reviewer", "work"] as const),
      prompt: Type.String(),
      cwd: Type.Optional(Type.String()),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cwd = params.cwd ?? ctx.cwd;

      // --- cwd validation ---
      if (params.cwd !== undefined) {
        if (typeof params.cwd !== "string" || params.cwd.length === 0) {
          throw new Error("cwd must be non-empty");
        }

        if (params.cwd.includes("\0")) {
          throw new Error("cwd must not contain null bytes");
        }
      }

      if (typeof cwd !== "string" || cwd.length === 0) {
        throw new Error("cwd must be non-empty");
      }

      if (cwd.includes("\0")) {
        throw new Error("cwd must not contain null bytes");
      }

      if (params.prompt.length > MAX_PROMPT_CHARS) {
        throw new Error(
          `prompt too long: ${params.prompt.length} > ${MAX_PROMPT_CHARS}`,
        );
      }

      const parentModel = ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : "(Pi default)";

      const profile = AGENT_PROFILES[params.mode];
      const thinking = profile.thinking;

      const details: AgentDetails = {
        mode: params.mode,
        status: "starting",

        model: parentModel,
        thinking,
        cwd,

        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 0,
        },

        activity: [],
        liveText: "",
        finalText: "",
      };

      /**
       * Updates are intentionally emitted only for coarse
       * lifecycle events.
       *
       * Do NOT call this on text_delta, streaming bash output,
       * or every stderr chunk. Those high-frequency redraws
       * cause the TUI cursor to jump.
       */
      const emitUpdate = () => {
        onUpdate?.({
          content: [
            {
              type: "text",
              text:
                details.finalText ||
                details.liveText ||
                "(subagent running...)",
            },
          ],

          details: {
            ...details,
            usage: {
              ...details.usage,
            },
            activity: [...details.activity],
          },
        });
      };

      emitUpdate();

      const systemPrompt = [
        "You are a delegated subagent.",
        "Complete only the assigned task.",

        profile.instruction,

        "Be concise.",
        "Report relevant file paths, commands, evidence, and final conclusions.",
        "Do not spawn or invoke other agents.",
      ].join(" ");

      const args = [
        "--mode",
        "json",

        "-p",
        "--no-session",

        // Do not inherit the agent extension.
        "--no-extensions",

        "--tools",
        profile.tools,

        "--append-system-prompt",
        systemPrompt,
      ];

      if (ctx.model) {
        args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
      }

      if (thinking) {
        args.push("--thinking", thinking);
      }

      // Stop option parsing before the prompt.
      args.push("--", params.prompt);

      let stderr = "";
      let aborted = false;

      const exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn("pi", args, {
          cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });

        details.status = "running";

        addActivity(details, "started");

        emitUpdate();

        child.stdout.setEncoding("utf8");

        child.stderr.setEncoding("utf8");

        let buffer = "";

        const processEvent = (event: any) => {
          try {
            if (!event || typeof event !== "object") {
              return;
            }

            /*
             * IMPORTANT:
             *
             * We intentionally ignore message_update.
             *
             * text_delta can arrive many times per second.
             * Repainting Pi's custom tool component for
             * every token causes terminal cursor jumping.
             *
             * We wait for message_end instead.
             */
            if (event.type === "message_update") {
              return;
            }

            /*
             * Tool start is useful live information and
             * occurs only once per tool invocation.
             */
            if (event.type === "tool_execution_start") {
              const toolName = event.toolName ?? "tool";

              addActivity(details, formatToolCall(toolName, event.args));

              emitUpdate();
              return;
            }

            /*
             * IMPORTANT:
             *
             * Ignore partial tool updates. Bash/read/etc.
             * may generate many of these and cause the
             * same repaint problem as text_delta.
             *
             * Completed output is captured below.
             */
            if (event.type === "tool_execution_update") {
              return;
            }

            /*
             * Tool completion is coarse-grained and safe
             * to repaint.
             */
            if (event.type === "tool_execution_end") {
              const toolName = event.toolName ?? "tool";

              addActivity(details, `${toolName} ${event.isError ? "✗" : "✓"}`);

              const output = toolResultText(event.result);

              if (output) {
                details.toolOutput = truncateTail(
                  output,
                  MAX_TOOL_OUTPUT_CHARS,
                );
              }

              emitUpdate();
              return;
            }

            /*
             * Completed messages.
             *
             * This gives us:
             * - assistant output
             * - token usage
             * - cache usage
             * - cost
             * - actual model/provider
             */
            if (event.type === "message_end" && event.message) {
              const message = event.message;

              if (message.role === "assistant") {
                const text = assistantText(message);

                if (text) {
                  details.finalText = text;

                  details.liveText = text;
                }

                /*
                 * Compatibility:
                 *
                 * If this Pi version does not emit
                 * tool_execution_start, tool calls can
                 * still be recovered from assistant
                 * message content.
                 */
                if (Array.isArray(message.content)) {
                  for (const part of message.content) {
                    if (part?.type !== "toolCall") {
                      continue;
                    }

                    addActivity(
                      details,
                      formatToolCall(
                        part.name ?? "tool",
                        part.arguments ?? part.args,
                      ),
                    );
                  }
                }

                details.usage.turns += 1;

                const usage = message.usage;

                if (usage) {
                  details.usage.input += usage.input ?? 0;

                  details.usage.output += usage.output ?? 0;

                  details.usage.cacheRead += usage.cacheRead ?? 0;

                  details.usage.cacheWrite += usage.cacheWrite ?? 0;

                  details.usage.cost += usage.cost?.total ?? 0;

                  /*
                   * totalTokens is the current/latest
                   * context size. Do not add it across
                   * turns.
                   */
                  details.usage.contextTokens = usage.totalTokens ?? 0;
                }

                if (typeof message.model === "string" && message.model) {
                  if (
                    typeof message.provider === "string" &&
                    message.provider
                  ) {
                    details.model = `${message.provider}/${message.model}`;
                  } else {
                    details.model = message.model;
                  }
                }

                if (message.stopReason) {
                  details.stopReason = message.stopReason;
                }

                addActivity(
                  details,
                  `assistant turn ${details.usage.turns} finished`,
                );
              }

              /*
               * Compatibility with versions that deliver
               * tool-result messages through message_end.
               */
              if (message.role === "toolResult") {
                const name = message.toolName ?? "tool";

                const output = contentToText(message.content);

                addActivity(details, `${name} result`);

                if (output) {
                  details.toolOutput = truncateTail(
                    output,
                    MAX_TOOL_OUTPUT_CHARS,
                  );
                }
              }

              emitUpdate();
              return;
            }

            /*
             * Compatibility with Pi's upstream subagent
             * event shape.
             */
            if (event.type === "tool_result_end" && event.message) {
              const message = event.message;

              const name = message.toolName ?? "tool";

              const output = contentToText(message.content);

              addActivity(details, `${name} result`);

              if (output) {
                details.toolOutput = truncateTail(
                  output,
                  MAX_TOOL_OUTPUT_CHARS,
                );
              }

              emitUpdate();
              return;
            }

            if (event.type === "turn_start") {
              addActivity(details, "LLM turn started");

              emitUpdate();
              return;
            }

            if (event.type === "agent_settled") {
              addActivity(details, "agent settled");

              emitUpdate();
            }
          } catch (e) {
            addActivity(details, `event error: ${String(e)}`);

            emitUpdate();
          }
        };

        const processLine = (line: string) => {
          if (!line.trim()) {
            return;
          }

          try {
            processEvent(JSON.parse(line));
          } catch {
            /*
             * Keep diagnostics for final output, but do
             * not repaint the TUI for malformed lines.
             */
            stderr += `\n[unparseable stdout] ${line}`;

            if (stderr.length > MAX_STDERR_CHARS) {
              stderr = truncateTail(stderr, MAX_STDERR_CHARS);
            }
          }
        };

        child.stdout.on("data", (chunk: string) => {
          buffer += chunk;

          if (buffer.length > MAX_BUFFER_CHARS) {
            buffer = truncateTail(buffer, MAX_BUFFER_CHARS);
          }

          const lines = buffer.split("\n");

          buffer = lines.pop() ?? "";

          for (const line of lines) {
            processLine(line);
          }
        });

        /*
         * IMPORTANT:
         *
         * Capture stderr, but do NOT emitUpdate() here.
         *
         * Some processes write stderr continuously, which
         * otherwise causes the same redraw problem.
         */
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;

          if (stderr.length > MAX_STDERR_CHARS) {
            stderr = truncateTail(stderr, MAX_STDERR_CHARS);
          }
        });

        let killTimer: ReturnType<typeof setTimeout> | undefined;

        const abort = () => {
          aborted = true;

          details.status = "aborted";

          addActivity(details, "abort requested");

          emitUpdate();

          child.kill("SIGTERM");

          killTimer = setTimeout(() => {
            if (child.exitCode === null) {
              child.kill("SIGKILL");
            }
          }, 5_000);

          (
            killTimer as unknown as {
              unref?: () => void;
            }
          )?.unref?.();
        };

        child.on("error", (err) => {
          if (killTimer) {
            clearTimeout(killTimer);
          }

          signal?.removeEventListener("abort", abort);

          details.status = "error";

          addActivity(details, `process error: ${String(err)}`);

          emitUpdate();

          reject(err);
        });

        child.on("close", (code) => {
          if (killTimer) {
            clearTimeout(killTimer);
          }

          signal?.removeEventListener("abort", abort);

          if (buffer.trim()) {
            processLine(buffer);
          }

          resolve(code ?? 1);
        });

        if (signal?.aborted) {
          abort();
        } else {
          signal?.addEventListener("abort", abort, {
            once: true,
          });
        }
      });

      details.exitCode = exitCode;

      if (aborted) {
        details.status = "aborted";

        emitUpdate();

        throw new Error("Subagent invocation aborted");
      }

      if (exitCode !== 0) {
        details.status = "error";

        addActivity(details, `process exited ${exitCode}`);

        emitUpdate();

        throw new Error(
          [
            `Subagent exited with code ${exitCode}`,
            stderr || details.finalText || "(no output)",
          ].join("\n"),
        );
      }

      details.status = "done";

      addActivity(details, "done");

      emitUpdate();

      const output = truncateOutput(details.finalText.trim());

      return {
        content: [
          {
            type: "text",

            text: [
              output || "(subagent returned no visible output)",

              "",
              "---",

              `model: ${details.model}`,
              `thinking: ${details.thinking}`,
              `mode: ${details.mode}`,

              formatUsage(details.usage),
            ].join("\n"),
          },
        ],

        details: {
          ...details,

          usage: {
            ...details.usage,
          },

          activity: [...details.activity],
        },
      };
    },

    renderResult(result, { expanded, isPartial }, theme, _context) {
      const details = result.details as AgentDetails | undefined;

      if (!details) {
        const content = result.content.find((x) => x.type === "text");

        return new Text(
          content?.type === "text" ? content.text : "(no output)",
          0,
          0,
        );
      }

      /*
       * CRITICAL FOR TUI STABILITY:
       *
       * While running, always render exactly four lines.
       *
       * Tool output, assistant text, and activity history are
       * deliberately excluded from the partial rendering.
       * Their varying height would make Pi reposition the
       * cursor on every update.
       */
      if (isPartial) {
        const raw = renderPartialDetails(details);

        const lines = raw.split("\n");

        const rendered = lines
          .map((line, index) => {
            if (index === 0) {
              return theme.fg("warning", line);
            }

            if (index === 1 || index === 2) {
              return theme.fg("muted", line);
            }

            return theme.fg("accent", line);
          })
          .join("\n");

        return new Text(rendered, 0, 0);
      }

      /*
       * After completion, render the full information.
       */
      const raw = renderDetails(details, expanded);

      const lines = raw.split("\n");

      const rendered = lines
        .map((line, index) => {
          if (index === 0) {
            if (details.status === "done") {
              return theme.fg("success", line);
            }

            if (details.status === "error" || details.status === "aborted") {
              return theme.fg("error", line);
            }

            return theme.fg("warning", line);
          }

          if (line.startsWith("model ")) {
            return theme.fg("muted", line);
          }

          if (line.startsWith("→ ")) {
            return theme.fg("muted", line);
          }

          if (line === "tool output:" || line === "assistant:") {
            return theme.fg("accent", line);
          }

          return line;
        })
        .join("\n");

      return new Text(rendered, 0, 0);
    },

    renderCall(args, theme, _context) {
      const mode = args.mode ?? "explorer";

      const prompt = args.prompt ?? "...";

      const preview = prompt.length > 100 ? `${prompt.slice(0, 100)}…` : prompt;

      return new Text(
        [
          theme.fg("toolTitle", theme.bold("agent invoke")),

          theme.fg("muted", ` [${mode}]`),

          `\n${theme.fg("dim", preview)}`,
        ].join(""),
        0,
        0,
      );
    },
  });
}
