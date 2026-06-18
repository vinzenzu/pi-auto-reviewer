# pi-auto-reviewer

Automatically review shell commands (PowerShell or bash) that your pi agent wants to execute — akin to Codex "Auto-review" and Claude Code "auto mode".

## How it works

Every shell command (PowerShell or bash) the agent wants to run is analyzed and routed through tiers:

| Tier | Action | Examples |
|------|--------|----------|
| **1. Auto-permitted** | Runs immediately | `ls`, `cd`, `grep`, `git status`, `npm list`, `echo` |
| **2. Auto-blocked** | Refused immediately | `rm -rf /`, `sudo`, `chmod 777`, `dd if=...`, `mkfs.*`, `shutdown`, `Start-Process -Verb RunAs` |
| **3. Reviewed by LLM** | Sent to a reviewer subagent | `git branch -D`, `git worktree remove`, `git push +refspec`, `git push --force`, `git reset --hard`, `rm -rf <dir>`, `Remove-Item -Recurse` |

When a command is reviewed, the subagent LLM receives the command plus detected **command behaviors** (e.g. "force-push", "branch-delete") and project context, then decides ALLOW or BLOCK.

### Behavior-based detection

Instead of relying only on regex, the extension parses commands for specific risky behaviors:

| Behavior | What triggers it |
|----------|------------------|
| `force-push` | `git push --force`, `--force-with-lease`, `--force-if-includes`, or a `+refspec` |
| `branch-delete` | `git branch -d`, `-D`, or `--delete` |
| `worktree-remove` | `git worktree remove` |
| `hard-reset` | `git reset --hard` |
| `git-clean` | `git clean -f`, `-x`, `-d` (not dry-run) |
| `recursive-delete` | `rm -r`, `rm -rf` |
| `remote-shell` | `curl \| sh`, `wget \| bash`, etc. |
| `powershell-recursive-delete` | `Remove-Item -Recurse`, `del`, `rmdir /s` |
| `privilege-escalation` | `sudo`, `Start-Process -Verb RunAs` |
| `broad-chmod` | `chmod 777` |
| `disk-destructive` | `dd if=...`, `mkfs.*`, `diskpart`, `format` |
| `system-shutdown` | `shutdown`, `reboot`, `halt`, `poweroff`, `Stop-Computer` |

These behaviors are included in the reviewer prompt so the LLM can make an informed decision rather than being tricked by syntax variations like `git push origin +branch`.

## Install

### All projects (global)

```bash
cp auto-reviewer.ts ~/.pi/agent/extensions/
```

### Via npm

```bash
pi install npm:pi-auto-reviewer
```

### Single project

Copy the extension into your project:

```bash
cp auto-reviewer.ts .pi/extensions/
```

Pi auto-discovers extensions in `.pi/extensions/` when the project is trusted.

### Single session

```bash
pi -e ./auto-reviewer.ts
```

On native Windows PowerShell, use the matching PowerShell copy commands and extension directory paths for your Pi install. The command rules include common PowerShell read-only commands such as `Get-Location`, `Get-ChildItem`, `Get-Content`, and `Test-Path`, plus Windows destructive/elevation patterns such as `Remove-Item -Recurse`, `cmd /c rmdir /s`, and `Start-Process -Verb RunAs`.

## Usage

Once installed, it works automatically — no configuration required. Every shell command the agent tries to run will be reviewed.

### What to expect

- **Safe commands** (Tier 1) run without any visible delay.
- **System-catastrophic commands** (Tier 2) are blocked with a notification explaining why.
- **Destructive or unknown commands** (Tier 3) pause while the reviewer LLM decides (up to 60s per attempt, with one automatic retry on failure). You'll see a status message: `Reviewing: <command>...`

  - If **allowed**: the command runs and you see `Auto-reviewer: ✓ <reason>`
  - If **blocked**: the command is refused and you see `Auto-reviewer: ✗ <reason>`
  - If the reviewer **fails** on both attempts (timeout, error): in interactive mode you're prompted to allow or deny manually; in non-interactive mode the command is blocked.

### Non-interactive mode

In print mode (`pi -p`) or JSON mode, reviewed commands are still sent to the reviewer LLM. If review fails (timeout, error), the command is blocked because there is no UI to fall back on.

## Configuration

By default, reviewed commands use your normal pi inference provider and model. You can route reviewer calls to a specific provider and model with environment variables:

| Variable | Purpose |
|----------|---------|
| `PI_REVIEWER_PROVIDER` | Inference provider for the reviewer subprocess, for example `opencode-go` |
| `PI_REVIEWER_MODEL` | Model for the reviewer subprocess, for example `deepseek-v4-flash` |

Set both provider/model variables together:

```bash
export PI_REVIEWER_PROVIDER=opencode-go
export PI_REVIEWER_MODEL=deepseek-v4-flash
pi
```

`export` only affects the current shell session. To keep these settings across new terminals, add the `export` lines to your shell startup file, for example `~/.bashrc` on many Linux and WSL setups. Other shells use different files, such as `~/.zshrc` for zsh.

If either `PI_REVIEWER_PROVIDER` or `PI_REVIEWER_MODEL` is missing or empty, the reviewer uses pi's configured default provider and model. This avoids accidentally selecting a model name from the wrong provider when the same model id is available in more than one place.

## Customizing review rules

Edit `AUTO_PERMITTED` and `AUTO_BLOCKED` arrays in `auto-reviewer.ts` to add or remove patterns. Edit `buildReviewPrompt()` and the behavior analyzer (`analyzeCommand` and helpers) to change how commands are classified and what the reviewer LLM sees.
