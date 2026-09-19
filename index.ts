import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Minimal pi-tty: one user-opened terminal session, exposed to the agent as two
 * tools. tmux owns the pty and the rendering, so the data plane is just
 * `send-keys` (write) and `capture-pane` (read). Outside tmux nothing is
 * registered, so the agent never sees the tools.
 */
export default function piTty(pi: ExtensionAPI): void {
  if (!process.env.TMUX) return;

  const windowName = "pi-tty";
  let paneId: string | null = null;
  let lastLines: readonly string[] = [];

  const tmux = async (args: string[]): Promise<string> => {
    const result = await pi.exec("tmux", args, {});
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() || `tmux ${args.join(" ")} failed (exit ${result.code})`,
      );
    }
    return result.stdout;
  };

  const paneAlive = async (target: string): Promise<boolean> => {
    try {
      const out = await tmux(["display-message", "-p", "-t", target, "-F", "#{pane_id}"]);
      return out.trim() === target;
    } catch {
      return false;
    }
  };

  const requireSession = async (): Promise<string> => {
    const target = paneId;
    if (target !== null && (await paneAlive(target))) return target;
    paneId = null;
    throw new Error("No managed terminal session is open. Run /tty first.");
  };

  /**
   * Lines added since the previous capture. The common prefix is compared line
   * by line, so a rewritten tail (the live prompt) is returned as a delta
   * instead of forcing a full resync; a shrunk screen resends everything.
   */
  const linesSince = (
    previous: readonly string[],
    current: readonly string[],
  ): readonly string[] => {
    if (current.length < previous.length) return current;
    let common = 0;
    while (common < previous.length && current[common] === previous[common]) common += 1;
    return current.slice(common);
  };

  pi.registerCommand("tty", {
    description: "Open the single managed terminal session",
    handler: async (args, ctx) => {
      if (args.trim().length > 0) {
        ctx.ui.notify("/tty takes no arguments", "error");
        return;
      }
      try {
        await ctx.waitForIdle();
        const existing = paneId;
        if (existing !== null && (await paneAlive(existing))) {
          await tmux(["select-pane", "-t", existing]);
          ctx.ui.notify("terminal session already open", "info");
          return;
        }
        const created = await tmux([
          "new-window",
          "-P",
          "-F",
          "#{pane_id}",
          "-n",
          windowName,
          ...(ctx.cwd.length > 0 ? ["-c", ctx.cwd] : []),
          "bash",
        ]);
        paneId = created.trim();
        lastLines = [];
        ctx.ui.notify("terminal session ready", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "send_tty",
    label: "send to teletype",
    description:
      "Send input to the managed terminal session. The far-end shell executes the bytes.",
    parameters: Type.Object({
      text: Type.String({ description: "Input to send to the terminal session." }),
      enter: Type.Optional(Type.Boolean({ description: "Append a newline after text." })),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      const target = await requireSession();
      const bytes = Buffer.byteLength(params.text, "utf8");
      await tmux(["send-keys", "-t", target, "-l", params.text]);
      if (params.enter ?? false) await tmux(["send-keys", "-t", target, "Enter"]);
      return {
        content: [{ type: "text", text: `Sent ${bytes} byte(s) to the terminal session.` }],
        details: { sentBytes: bytes },
      };
    },
  });

  pi.registerTool({
    name: "recv_tty",
    label: "receive from teletype",
    description:
      "Read output from the managed terminal session. last (default) returns lines added since the previous call; all returns the whole captured buffer.",
    parameters: Type.Object({
      since: Type.Optional(
        Type.Union([Type.Literal("last"), Type.Literal("all")], {
          description: "last: new lines only (default). all: the entire buffer.",
        }),
      ),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      const target = await requireSession();
      const raw = await tmux(["capture-pane", "-p", "-S", "-", "-t", target]);
      // Drop the trailing blank rows tmux pads the pane with so they do not
      // shift the line diff.
      const current = raw.replace(/\s+$/, "").split("\n");
      const since = params.since ?? "last";
      const lines = since === "all" ? current : linesSince(lastLines, current);
      lastLines = current;
      const text = lines.join("\n");
      return {
        content: [{ type: "text", text }],
        details: { since, lines: text.length === 0 ? 0 : lines.length },
      };
    },
  });

  pi.on("session_shutdown", async () => {
    const target = paneId;
    paneId = null;
    if (target !== null) {
      await tmux(["kill-pane", "-t", target]).catch(() => undefined);
    }
  });
}
