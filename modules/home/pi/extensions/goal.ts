import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Goal = {
  objective: string;
  status: "active" | "complete";
};

let goal: Goal | null = null;
let lastObjective: string | null = null;
let continuationQueued = false;
let toolRegistered = false;

function continuationPrompt(objective: string): string {
  return `Continue working toward the active goal.

Objective: ${objective}

Choose the next concrete action toward the objective and avoid repeating work that is already done.

Before deciding the goal is achieved, verify against real evidence (files, command output, test results) that every requirement is met. Treat uncertainty as not done. When — and only when — the objective is fully achieved, call complete_goal. Do not call complete_goal for any other reason.`;
}

export default function goalExtension(pi: ExtensionAPI) {
  // Only load complete_goal tool when /goal is used to avoid polluting context
  // This causes a cache invalidation (increasing token cost), however as i use goal early on its fine.
  function ensureToolRegistered() {
    if (toolRegistered) return;
    toolRegistered = true;
    pi.registerTool({
      name: "complete_goal",
      label: "Complete Goal",
      description:
        "Mark the current active goal complete. Call this only once the goal's objective is fully achieved and verified.",
      promptSnippet: "Mark the current goal complete after verifying the objective is fully achieved",
      promptGuidelines: [
        "Use complete_goal only when the current goal objective is fully achieved and verified against concrete evidence.",
        "Do not call complete_goal to pause, abandon, or stop a goal for any other reason.",
      ],
      parameters: Type.Object({}),
      async execute() {
        if (!goal) {
          return { content: [{ type: "text", text: "No goal is set." }], isError: true };
        }
        goal = { ...goal, status: "complete" };
        continuationQueued = false;
        return { content: [{ type: "text", text: "Goal marked complete." }] };
      },
    });
  }

  pi.registerCommand("goal", {
    description: "Set a long-running goal the agent pursues until complete",
    handler: async (args, ctx) => {
      const objective = args.trim();
      if (!objective) {
        ctx.ui.notify("Usage: /goal <objective>", "info");
        return;
      }
      startGoal(objective, ctx);
    },
  });

  pi.registerCommand("goal-resume", {
    description: "Resume the last goal, re-running /goal with the same objective",
    handler: async (_args, ctx) => {
      if (!lastObjective) {
        ctx.ui.notify("No previous goal to resume.", "info");
        return;
      }
      startGoal(lastObjective, ctx);
    },
  });

  pi.registerCommand("crits", {
    description: "Find critical vulnerabilities in a codebase",
    handler: async (_args, ctx) => {
      const presetGoal = `Find a unique (known findings are listed in KNOWN-FINDINGS.md) critical vulnerability in the codebase. Verify identified vulnerabilities end to end by tracing code flow. Clone third party modules to refer to the source authoritatively instead of recalling from memory. Keep track of progress in PROGRESS.md.`;
      startGoal(presetGoal, ctx);
    },
  });

  function startGoal(objective: string, ctx: ExtensionCommandContext) {
    ensureToolRegistered();
    goal = { objective, status: "active" };
    lastObjective = objective;
    continuationQueued = false;
    ctx.ui.notify(`Goal set: ${objective}`, "info");
    pi.sendMessage(
      {
        customType: "goal",
        content: continuationPrompt(objective),
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }

  pi.on("agent_end", (event, ctx) => {
    if (!goal || goal.status !== "active") return;

    // Abort if user presses escape
    const wasAborted = event.messages.some(
      (message) => message.role === "assistant" && message.stopReason === "aborted",
    );
    if (wasAborted) {
      goal = null;
      continuationQueued = false;
      ctx.ui.notify("Goal cancelled.", "info");
      return;
    }

    if (ctx.hasPendingMessages()) return;
    if (continuationQueued) return;
    continuationQueued = true;
    queueMicrotask(() => {
      continuationQueued = false;
      if (!goal || goal.status !== "active") return;
      pi.sendMessage(
        {
          customType: "goal",
          content: continuationPrompt(goal.objective),
          display: true,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    });
  });
}
