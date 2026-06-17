# pi-auto-reviewer

Automatically review bash commands that your pi agent wants to execute - akin to Codex "Auto-review" and Claude Code "auto mode".

## How it works

Every bash command the agent wants to run goes through three tiers:

| Tier | Action | Examples |
|------|--------|----------|
| **1. Auto-permitted** | Runs immediately | `ls`, `cd`, `grep`, `git status`, `npm list`, `echo` |
| **2. Auto-blocked** | Refused immediately | `rm -rf`, `sudo`, `chmod 777`, `git push --force`, `shutdown` |
| **3. Needs review** | Sent to a reviewer LLM | `git commit`, `npm install`, `curl`, `mv`, `sed -i`, `cp` |

When a command falls into **Tier 3**, a subagent LLM reviews the command with project context and decides ALLOW or BLOCK.

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

## Usage

Once installed, it works automatically - no configuration required. Every bash command the agent tries to run will be reviewed.

### What to expect

- **Safe commands** (Tier 1) run without any visible delay.
- **Dangerous commands** (Tier 2) are blocked with a notification explaining why.
- **Everything else** (Tier 3) pauses briefly while the reviewer LLM decides. You'll see a status message: `Reviewing: <command>...`

  - If **allowed**: the command runs and you see `Auto-reviewer: ✓ <reason>`
  - If **blocked**: the command is refused and you see `Auto-reviewer: ✗ <reason>`
  - If the reviewer **fails** (timeout, error): you're prompted interactively to allow or deny manually.

### Non-interactive mode

In print mode (`pi -p`) or JSON mode, Tier 3 commands are blocked by default since there's no UI to fall back on.

## Configuration

By default, Tier 3 review uses your normal pi inference provider and model. You can route reviewer calls to a specific provider and model with environment variables:

| Variable | Purpose |
|----------|---------|
| `PI_REVIEWER_PROVIDER` | Inference provider for the reviewer subprocess, for example `opencode-go` |
| `PI_REVIEWER_MODEL` | Model for the reviewer subprocess, for example `deepseek-v4-flash` |

Set both variables together:

```bash
export PI_REVIEWER_PROVIDER=opencode-go
export PI_REVIEWER_MODEL=deepseek-v4-flash
pi
```

`export` only affects the current shell session. To keep these settings across new terminals, add the two `export` lines to your shell startup file, for example `~/.bashrc` on many Linux and WSL setups. Other shells use different files, such as `~/.zshrc` for zsh.

If either variable is missing or empty, the reviewer uses pi's configured default provider and model. This avoids accidentally selecting a model name from the wrong provider when the same model id is available in more than one place.

## Customizing review rules

Edit `AUTO_PERMITTED` and `AUTO_BLOCKED` arrays in `auto-reviewer.ts` to add or remove patterns. Edit `buildReviewPrompt()` to change how the reviewer LLM decides.
