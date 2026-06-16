/**
 * Auto-Reviewer Extension
 *
 * Auto-reviews bash commands before execution, similar to Codex's auto-reviewer.
 *
 * Three tiers:
 *   1. Auto-permitted: safe commands (ls, cd, grep, git status, etc.)
 *   2. Auto-blocked: obviously dangerous (rm -rf, sudo, chmod 777)
 *   3. Needs review: everything else → call a subagent LLM to decide
 *
 * The reviewer subagent gets: the command, current directory, and project context.
 * It returns a decision (allow/block) with a reason.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Tier 1: Auto-permitted command patterns ──
//
// These are regexps tested against the full command string.
// The model will never see these — they bypass review entirely.
const AUTO_PERMITTED = [
    // Read-only directory listing
    /^(ls|dir|tree)\b/,
    // Directory navigation
    /^cd\b/,
    // Read-only file ops
    /^(cat|head|tail|less|more)\b/,
    /^(file|stat|wc|du|df)\b/,
    // grep / rg / ag — read-only search
    /^(grep|rg|ag|ack)\b/,
    // find / locate — read-only
    /^(find|locate|which|whereis|type)\b/,
    // Git read-only operations
    /^git\s+(status|log|diff|show|branch|tag|stash\s+list|remote|ls-remote|rev-parse|rev-list|describe|whatchanged|shortlog|blame|grep|config\s+--get|config\s+--list|config\s+-l)\b/,
    /^git\s+log\b/,
    // Docker/container read-only
    /^(docker|podman)\s+(ps|images|inspect|logs|stats|info|version|history|top|diff)\b/,
    // Package manager info/list
    /^(npm|yarn|pnpm)\s+(list|info|view|outdated|audit|why|config\s+list)\b/,
    /^(pip|pip3)\s+(list|show|freeze|search)\b/,
    /^(cargo|go)\s+(search|doc)\b/,
    // System info
    /^(echo|printenv|env|whoami|hostname|uname|uptime|id|groups|pwd|date)\b/,
    // Python/node one-off checks (no args = safe)
    /^(python3?|node|uv|tsx|npx)\s+(--version|-v|--help|-h)$/,
    // Help flags
    /^.*\s+(--help|-h)\s*$/,
    // Simple echo (for env var checks, etc.)
    /^echo\s/,
    // Print working directory
    /^pwd\b/,
];

// ── Tier 2: Auto-blocked patterns (never run, never ask) ──
const AUTO_BLOCKED = [
    // Destructive file ops
    /\brm\s+(-rf?|--recursive)\b/,
    /\brm\s+(-rf?|--recursive)\s+\/\b/,
    // Privilege escalation
    /\bsudo\b/,
    // Permission changes that are too open
    /\bchmod\s+.*777/,
    // Fork bombs and resource exhaustion
    /:\(\)\s*\{/,  // fork bomb pattern
    // Disk destructive
    /\bdd\s+if=/,
    /\bmkfs\./,
    // System shutdown
    /\b(shutdown|reboot|halt|poweroff)\b/,
    // Git destructive without review
    /\bgit\s+(push\s+--force|reset\s+--hard|clean\s+-[fd]+)\b/,
];

// ── Review prompt template ──
function buildReviewPrompt(command: string, cwd: string): string {
    const projectName = path.basename(cwd);
    return `You are a security reviewer for a coding agent. You must decide whether to ALLOW or BLOCK the following bash command.

=== COMMAND ===
${command}

=== CURRENT DIRECTORY ===
${cwd}

=== PROJECT ===
${projectName}

=== REVIEW RULES ===
1. Commands that ONLY read files, list directories, show info, or display state → ALLOW
2. Commands that modify files or system state → ALLOW if constructive (install deps, build, lint, format, test)
3. Commands that delete files, force-push, reset, or alter system config → BLOCK unless clearly intentional and scoped
4. Commands with environment variables like $SECRET or $TOKEN → BLOCK to prevent leaks
5. Commands that install from unverified sources (curl pipe bash, wget pipe sh) → BLOCK
6. Package manager installs (npm install, pip install, cargo add) → ALLOW (standard dev workflow)
7. Network operations like curl/wget to download files → ALLOW if to a project directory, BLOCK if suspicious
8. Any command that would affect files outside the project directory → BLOCK unless clearly a dev tool

=== RESPONSE FORMAT ===
Reply with ONLY one line:
- "ALLOW: <brief reason>" — to permit the command
- "BLOCK: <brief reason>" — to prevent the command

Do not include any other text, markdown, or explanation.`;
}

// ── Spawn a pi subprocess to review the command ──
async function reviewWithLLM(
    command: string,
    cwd: string,
    signal: AbortSignal | undefined,
): Promise<{ allowed: boolean; reason: string }> {
    const prompt = buildReviewPrompt(command, cwd);

    // Write prompt to temp file
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-reviewer-"));
    const promptPath = path.join(tmpDir, "review-prompt.md");
    await fs.promises.writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 });

    try {
        // Resolve pi invocation
        let piCmd: string;
        let piArgs: string[];
        const execPath = process.execPath;
        const currentScript = process.argv[1];

        if (currentScript && fs.existsSync(currentScript)) {
            piCmd = execPath;
            piArgs = [currentScript];
        } else {
            piCmd = "pi";
            piArgs = [];
        }

        piArgs.push(
            "--mode", "json", "-p",
            "--no-session",
            "--no-extensions",
            "--no-context-files",
            "--no-skills",
            "--no-prompt-templates",
            "--thinking", "minimal",
        );

        // Pass prompt as a positional argument (same approach as subagent example)
        piArgs.push(prompt);

        let capturedStderr = "";

        const fullOutput = await new Promise<string>((resolve, reject) => {
            const proc = spawn(piCmd, piArgs, {
                cwd,
                shell: false,
                stdio: ["ignore", "pipe", "pipe"],
            });

            let stdout = "";

            proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
            proc.stderr.on("data", (data: Buffer) => { capturedStderr += data.toString(); });

            const timeout = setTimeout(() => {
                proc.kill("SIGTERM");
                reject(new Error("Review timed out after 15s"));
            }, 15000);

            proc.on("close", (code) => {
                clearTimeout(timeout);
                if (code === 0 || code === null) {
                    resolve(stdout.trim());
                } else {
                    reject(new Error(`Reviewer exited with code ${code}: ${capturedStderr}`));
                }
            });

            proc.on("error", (err) => {
                clearTimeout(timeout);
                reject(err);
            });

            if (signal) {
                const abortHandler = () => {
                    clearTimeout(timeout);
                    proc.kill("SIGTERM");
                    reject(new Error("Review aborted"));
                };
                if (signal.aborted) abortHandler();
                else signal.addEventListener("abort", abortHandler, { once: true });
            }
        });

        // DEBUG: dump full output to fixed temp file for inspection
        const debugPath = path.join(os.tmpdir(), "pi-reviewer-debug.txt");
        let debugContent = `=== DEBUG ${new Date().toISOString()} ===\n`;
        debugContent += `STDOUT (${fullOutput.length} chars):\n${fullOutput}\n\n`;
        debugContent += `STDERR (${capturedStderr.length} chars):\n${capturedStderr || "(empty)"}\n`;
        await fs.promises.writeFile(debugPath, debugContent, { encoding: "utf8" });

        // Parse: NDJSON output from `pi --mode json -p`.
        // Each line is a JSON object. Extract text content from assistant
        // messages and search for ALLOW/BLOCK decision within that text.
        const lines = fullOutput.split("\n");
        let decision: { allowed: boolean; reason: string } | null = null;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Search for text content in JSON line (text_delta / text_end / message_end)
            let searchText: string | null = null;
            try {
                const parsed = JSON.parse(trimmed);
                // message_end: extract text from assistant message content
                if (parsed.type === "message_end" && parsed.message?.role === "assistant") {
                    for (const block of parsed.message.content || []) {
                        if (block.type === "text" && block.text) {
                            searchText = block.text;
                            break;
                        }
                    }
                }
                // message_update with text_delta / text_end
                if (!searchText && parsed.assistantMessageEvent) {
                    const evt = parsed.assistantMessageEvent;
                    if ((evt.type === "text_delta" || evt.type === "text_end") && evt.content) {
                        searchText = evt.content;
                    }
                }
            } catch {
                // Not valid JSON; treat trimmed line as plain text
                searchText = trimmed;
            }

            if (searchText) {
                const allowMatch = searchText.match(/^ALLOW:\s*(.+)/i);
                const blockMatch = searchText.match(/^BLOCK:\s*(.+)/i);

                if (allowMatch) {
                    decision = { allowed: true, reason: allowMatch[1].trim() };
                } else if (blockMatch) {
                    decision = { allowed: false, reason: blockMatch[1].trim() };
                }
            }
        }

        if (decision) {
            return decision;
        }

        // Fallback: couldn't parse → block conservatively
        return { allowed: false, reason: `Reviewer response unclear: "${fullOutput.slice(0, 200)}"` };
    } finally {
        // Cleanup temp files
        try { fs.unlinkSync(promptPath); } catch { /* ignore */ }
        try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
    }
}

export default function (pi: ExtensionAPI) {
    pi.on("tool_call", async (event, ctx) => {
        if (event.toolName !== "bash") return undefined;

        const command = (event.input.command as string).trim();
        if (!command) return undefined;

        // Tier 2: Auto-blocked
        for (const pattern of AUTO_BLOCKED) {
            if (pattern.test(command)) {
                return { block: true, reason: `Auto-blocked: matches dangerous pattern "${pattern.source}"` };
            }
        }

        // Tier 1: Auto-permitted
        for (const pattern of AUTO_PERMITTED) {
            if (pattern.test(command)) {
                return undefined; // allow through
            }
        }

        // Tier 3: Needs review
        if (!ctx.hasUI) {
            // Non-interactive mode: block by default
            return { block: true, reason: "Command requires review but no UI available" };
        }

        ctx.ui.setStatus("auto-reviewer", `Reviewing: ${command.slice(0, 60)}...`);

        try {
            const decision = await reviewWithLLM(command, ctx.cwd, ctx.signal);

            ctx.ui.setStatus("auto-reviewer", undefined);

            if (decision.allowed) {
                ctx.ui.notify(`Auto-reviewer: ✓ ${decision.reason}`, "info");
                return undefined; // allow through
            } else {
                ctx.ui.notify(`Auto-reviewer: ✗ ${decision.reason}`, "warning");
                return { block: true, reason: `Auto-reviewer blocked: ${decision.reason}` };
            }
        } catch (err) {
            ctx.ui.setStatus("auto-reviewer", undefined);
            const msg = err instanceof Error ? err.message : String(err);

            // On review failure, ask user
            const choice = await ctx.ui.select(
                `⚠️  Auto-review failed: ${msg}\n\nCommand: ${command}\n\nAllow?`,
                ["Yes", "No"],
            );
            if (choice !== "Yes") {
                return { block: true, reason: "Auto-review failed and user declined" };
            }
            return undefined;
        }
    });

    // Clean up status on session end
    pi.on("session_shutdown", async (_event, _ctx) => {
        // No cleanup needed; status is session-scoped
    });
}
