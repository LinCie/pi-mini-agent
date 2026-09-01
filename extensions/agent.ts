import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CHILD_TOOLS = {
  read: "read,grep,find,ls",
  work: "read,grep,find,ls,write,edit,bash",
} as const;

type AgentMode = keyof typeof CHILD_TOOLS;

const MAX_OUTPUT_CHARS = 50_000;
const MAX_OUTPUT_LINES = 2_000;
const MAX_LIVE_TEXT_CHARS = 8_000;
const MAX_TOOL_OUTPUT_CHARS = 4_000;
const MAX_ACTIVITY = 20;

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
  action: "invoke";
  mode: AgentMode;

  status: "starting" | "running" | "done" | "error" | "aborted";

  model: string;
  thinking: string;
  cwd: string;

  usage: UsageStats;

  activity: string[];

  // Current streaming assistant response.
  liveText: string;

  // Last completed assistant response.
  finalText: string;

  // Partial output from the currently running tool.
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

  const assistant = details.liveText || details.finalText;

  if (assistant) {
    lines.push("");
    lines.push("assistant:");

    if (expanded) {
      lines.push(assistant);
    } else {
      lines.push(truncateTail(assistant, MAX_LIVE_TEXT_CHARS));
    }
  }

  if (!expanded && details.status === "running") {
    lines.push("");
    lines.push("(Ctrl+O to expand)");
  }

  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "agent",
    label: "Agent",

    description:
      "Invoke an isolated Pi subagent. Supports read-only and working modes, streams visible activity, and reports model, thinking effort, tokens, cache usage, and cost.",

    promptSnippet: "Invoke an isolated Pi subagent",

    promptGuidelines: [
      "Use mode='read' for investigation, research, review, and analysis.",
      "Use mode='work' when the delegated task should edit files or execute commands.",
      "The child inherits the current Pi model and thinking level.",
      "Do not delegate trivial work.",
      "Verify important subagent conclusions before acting on them.",
    ],

    parameters: Type.Object({
      action: StringEnum(["invoke"] as const, {
        description: "Agent operation. Currently only 'invoke'.",
      }),

      mode: StringEnum(["read", "work"] as const, {
        description:
          "'read' can only inspect files. 'work' may edit files and execute bash commands.",
      }),

      prompt: Type.String({
        description: "Complete task or question for the subagent.",
      }),

      cwd: Type.Optional(
        Type.String({
          description:
            "Working directory for the child. Defaults to the parent's cwd.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cwd = params.cwd ?? ctx.cwd;

      const parentModel = ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : "(Pi default)";

      // getThinkingLevel() is authoritative for the current
      // session; ctx.thinkingLevel is kept as fallback.
      const thinking = pi.getThinkingLevel?.() ?? ctx.thinkingLevel ?? "off";

      const details: AgentDetails = {
        action: "invoke",
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

      const emitUpdate = () => {
        onUpdate?.({
          content: [
            {
              type: "text",
              text:
                details.liveText ||
                details.finalText ||
                "(subagent running...)",
            },
          ],

          // Clone enough state that the renderer always sees
          // the current snapshot.
          details: {
            ...details,
            usage: { ...details.usage },
            activity: [...details.activity],
          },
        });
      };

      emitUpdate();

      const systemPrompt = [
        "You are a delegated subagent.",
        "Complete only the assigned task.",

        params.mode === "read"
          ? "You are read-only. Inspect and analyze, but do not modify files."
          : "You may modify files and run commands when required by the task.",

        "Be concise.",
        "Report relevant file paths, commands, evidence, and final conclusions.",
        "Do not spawn or invoke other agents.",
      ].join(" ");

      const args = [
        "--mode",
        "json",
        "-p",
        "--no-session",

        // Prevent this extension from being inherited by the
        // child Pi process.
        "--no-extensions",

        "--tools",
        CHILD_TOOLS[params.mode],

        "--append-system-prompt",
        systemPrompt,
      ];

      // Explicitly inherit the current parent's model.
      if (ctx.model) {
        args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
      }

      // Explicitly inherit current thinking effort.
      if (thinking) {
        args.push("--thinking", thinking);
      }

      // Prevent prompts beginning with "-" from becoming flags.
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
          if (!event || typeof event !== "object") {
            return;
          }

          /*
           * Streaming assistant output.
           *
           * Pi JSON mode emits message_update events with an
           * assistantMessageEvent containing text_delta,
           * thinking_delta, toolcall_delta, etc.
           *
           * We deliberately expose text_delta but not raw
           * thinking_delta.
           */
          if (event.type === "message_update") {
            const update = event.assistantMessageEvent;

            if (!update) return;

            if (update.type === "text_start") {
              details.liveText = "";
              emitUpdate();
              return;
            }

            if (
              update.type === "text_delta" &&
              typeof update.delta === "string"
            ) {
              details.liveText += update.delta;

              if (details.liveText.length > MAX_LIVE_TEXT_CHARS * 4) {
                details.liveText = truncateTail(
                  details.liveText,
                  MAX_LIVE_TEXT_CHARS * 4,
                );
              }

              emitUpdate();
              return;
            }

            /*
             * We intentionally do not display
             * thinking_delta. We expose the configured
             * thinking effort, not hidden chain-of-thought.
             */

            return;
          }

          /*
           * Newer Pi event shape: tool execution lifecycle.
           */
          if (event.type === "tool_execution_start") {
            const toolName = event.toolName ?? "tool";

            addActivity(details, formatToolCall(toolName, event.args));

            details.toolOutput = undefined;
            emitUpdate();
            return;
          }

          if (event.type === "tool_execution_update") {
            const output = toolResultText(event.partialResult);

            if (output) {
              details.toolOutput = truncateTail(output, MAX_TOOL_OUTPUT_CHARS);

              emitUpdate();
            }

            return;
          }

          if (event.type === "tool_execution_end") {
            const toolName = event.toolName ?? "tool";

            addActivity(details, `${toolName} ${event.isError ? "✗" : "✓"}`);

            const output = toolResultText(event.result);

            if (output) {
              details.toolOutput = truncateTail(output, MAX_TOOL_OUTPUT_CHARS);
            } else {
              details.toolOutput = undefined;
            }

            emitUpdate();
            return;
          }

          /*
           * Completed messages.
           *
           * This is also where authoritative provider token
           * usage is available.
           */
          if (event.type === "message_end" && event.message) {
            const message = event.message;

            if (message.role === "assistant") {
              const text = assistantText(message);

              if (text) {
                details.finalText = text;
                details.liveText = text;
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
                 * Do not sum usage.totalTokens across turns.
                 * In Pi this represents the latest context
                 * token count, not a cumulative billing
                 * counter.
                 */
                details.usage.contextTokens = usage.totalTokens ?? 0;
              }

              if (typeof message.model === "string" && message.model) {
                if (typeof message.provider === "string" && message.provider) {
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
             * Some Pi versions emit tool-result messages as
             * message_end rather than only via
             * tool_execution_end.
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
           * Compatibility with the event shape used by Pi's
           * upstream subagent extension.
           */
          if (event.type === "tool_result_end" && event.message) {
            const message = event.message;

            const name = message.toolName ?? "tool";

            const output = contentToText(message.content);

            addActivity(details, `${name} result`);

            if (output) {
              details.toolOutput = truncateTail(output, MAX_TOOL_OUTPUT_CHARS);
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
        };

        const processLine = (line: string) => {
          if (!line.trim()) {
            return;
          }

          try {
            processEvent(JSON.parse(line));
          } catch {
            /*
             * JSON mode should emit JSONL. Ignore any
             * unexpected non-protocol stdout.
             */
          }
        };

        child.stdout.on("data", (chunk: string) => {
          buffer += chunk;

          const lines = buffer.split("\n");

          buffer = lines.pop() ?? "";

          for (const line of lines) {
            processLine(line);
          }
        });

        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;

          /*
           * stderr can contain useful process-level
           * diagnostics. Surface the tail while running.
           */
          details.toolOutput = truncateTail(stderr, MAX_TOOL_OUTPUT_CHARS);

          emitUpdate();
        });

        child.on("error", reject);

        child.on("close", (code) => {
          if (buffer.trim()) {
            processLine(buffer);
          }

          resolve(code ?? 1);
        });

        const abort = () => {
          aborted = true;

          details.status = "aborted";
          addActivity(details, "abort requested");

          emitUpdate();

          child.kill("SIGTERM");

          setTimeout(() => {
            if (child.exitCode === null) {
              child.kill("SIGKILL");
            }
          }, 5_000).unref();
        };

        if (signal?.aborted) {
          abort();
        } else {
          signal?.addEventListener("abort", abort, { once: true });
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
      details.toolOutput = undefined;

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
          usage: { ...details.usage },
          activity: [...details.activity],
        },
      };
    },

    /*
     * This is important.
     *
     * onUpdate() updates the partial result while execute() is
     * running. renderResult() controls how those partial results
     * are actually shown in Pi's TUI.
     */
    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as AgentDetails | undefined;

      if (!details) {
        const content = result.content.find((x) => x.type === "text");

        return new Text(
          content?.type === "text" ? content.text : "(no output)",
          0,
          0,
        );
      }

      const raw = renderDetails(details, expanded);

      /*
       * Add some lightweight TUI styling while keeping the
       * actual live output unchanged.
       */
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

          if (line === "(Ctrl+O to expand)") {
            return theme.fg("dim", line);
          }

          return line;
        })
        .join("\n");

      return new Text(rendered, 0, 0);
    },

    renderCall(args, theme, _context) {
      const mode = args.mode ?? "read";

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
