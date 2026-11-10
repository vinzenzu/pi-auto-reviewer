import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../auto-reviewer.ts";

const hasBash = !spawnSync("bash", ["--version"]).error;
const hasGit = !spawnSync("git", ["--version"]).error;
const hasRg = !spawnSync("rg", ["--version"]).error;
const hasPython = !spawnSync("python3", ["--version"]).error;

function quote(value: string): string {
    return "'" + value.replaceAll("'", "'\\''") + "'";
}

test("real shell effects are stopped by the extension's review boundary", { skip: !hasBash }, async t => {
    const keys = ["PI_REVIEWER_BACKEND", "PI_REVIEWER_PROVIDER", "PI_REVIEWER_MODEL", "PI_REVIEWER_ENDPOINT", "PI_REVIEWER_API_KEY_ENV"];
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const originalFetch = globalThis.fetch;
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, { PI_REVIEWER_BACKEND: "jev", PI_REVIEWER_PROVIDER: "openrouter", PI_REVIEWER_MODEL: "typesafe/jev" });
    t.after(() => {
        globalThis.fetch = originalFetch;
        for (const key of keys) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });
    let reviewCalls = 0;
    globalThis.fetch = async () => {
        reviewCalls++;
        return Response.json({ answers: { command_review: {
            type: "choice", choice: "block", confidence: 0.99, probabilities: { allow: 0.01, block: 0.99 },
        } } });
    };
    const cases = [
        { command: "echo hello | grep -q missing || ./helper.sh" },
        { command: "echo hello | head -n 1\n./helper.sh" },
        { command: "env ./helper.sh" },
        { command: "find input -exec ./helper.sh {} +" },
        { command: "sort -o marker input" },
        { command: "sort --output=marker input" },
        { command: "uniq input marker" },
        { command: "sort -S32K --compress-program=./compress.sh input", largeInput: true },
        { command: "echo 'open(\"marker\",\"w\").write(\"ran\")' | python3 -v", skip: !hasPython },
        { command: "git log --pretty --output=marker", git: true, skip: !hasGit },
        { command: "git log --format --output=marker", git: true, skip: !hasGit },
        { command: "git status", git: true, fsmonitor: true, skip: !hasGit },
        { command: "rg needle input", rg: true, skip: !hasRg },
    ];
    for (const fixture of cases) {
        await t.test(fixture.command, { skip: fixture.skip }, async t => {
            const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-shell-"));
            t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
            const marker = path.join(cwd, "marker");
            const helper = path.join(cwd, "helper.sh");
            const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
            Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devnull });
            fs.writeFileSync(helper, `#!/bin/sh\nprintf called >> ${quote(marker)}\nprintf 'needle\\n'\n`, { mode: 0o700 });
            fs.writeFileSync(path.join(cwd, "compress.sh"), `#!/bin/sh\nprintf called >> ${quote(marker)}\ncat\n`, { mode: 0o700 });
            fs.writeFileSync(path.join(cwd, "input"), fixture.largeInput
                ? Array.from({ length: 200000 }, (_, i) => `${200000 - i}\n`).join("") : "needle\nb\nb\na\n");
            const git = (args: string[], input?: string) => {
                const result = spawnSync("git", args, { cwd, env, input, encoding: "utf8", timeout: 10000 });
                assert.equal(result.status, 0, result.stderr);
                return result.stdout.trim();
            };
            if (fixture.git) {
                git(["init", "-q"]);
                const tree = git(["mktree"], "");
                // Synthetic fixture data; no commits are made in the working repository.
                const object = `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\nFixture\n`;
                const commit = git(["hash-object", "-w", "-t", "commit", "--stdin"], object);
                git(["update-ref", "HEAD", commit]);
                if (fixture.fsmonitor) git(["config", "core.fsmonitor", helper]);
            }
            if (fixture.rg) {
                const config = path.join(cwd, "ripgrep.conf");
                fs.writeFileSync(config, `--pre=${helper}\n`);
                env.RIPGREP_CONFIG_PATH = config;
            }
            const execute = () => spawnSync("bash", ["--noprofile", "--norc", "-c", fixture.command],
                { cwd, env, encoding: "utf8", timeout: 15000, maxBuffer: 4 * 1024 * 1024 });

            // Establish the actual effect independently of the permission checks.
            const baseline = execute();
            assert.equal(baseline.error, undefined);
            assert.equal(fs.existsSync(marker), true, `Fixture did not produce its effect: ${baseline.stderr}`);
            fs.unlinkSync(marker);

            const handlers = new Map<string, any>();
            extension({ on: (name: string, handler: any) => handlers.set(name, handler),
                appendEntry() {}, events: { emit() {} },
            } as any);
            const ctx: any = { cwd, hasUI: false, isProjectTrusted: () => false,
                sessionManager: { getSessionId: () => cwd, getBranch: () => [], appendUsage() {} },
                modelRegistry: { getApiKeyForProvider: async () => "fixture-key" },
            };
            handlers.get("session_start")({}, ctx);
            try {
                const before = reviewCalls;
                const verdict = await handlers.get("tool_call")({ toolName: "bash", toolCallId: "guarded", input: { command: fixture.command } }, ctx);
                if (!verdict?.block) execute();
                assert.equal(reviewCalls, before + 1, "The command must reach review");
                assert.equal(verdict?.block, true);
                assert.equal(fs.existsSync(marker), false, "A denied command must not produce its effect");
                if (fixture.fsmonitor) {
                    const denied = await handlers.get("tool_call")({ toolName: "bash", toolCallId: "other-review", input: { command: "npm test" } }, ctx);
                    assert.equal(denied.block, true);
                    assert.equal(fs.existsSync(marker), false, "Context collection must not execute fsmonitor for any reviewed command");
                }
                if (fixture.rg) {
                    const beforeSafe = reviewCalls;
                    const safe = "rg --no-config needle input";
                    assert.equal(await handlers.get("tool_call")({ toolName: "bash", input: { command: safe } }, ctx), undefined);
                    assert.equal(reviewCalls, beforeSafe);
                    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", safe], { cwd, env, encoding: "utf8", timeout: 5000 });
                    assert.equal(result.status, 0, result.stderr);
                    assert.match(result.stdout, /needle/);
                    assert.equal(fs.existsSync(marker), false, "--no-config must suppress the configured preprocessor");
                }
            } finally {
                await handlers.get("session_shutdown")({}, ctx);
            }
        });
    }
});

test("literal quoting agrees with Bash through the extension handler", { skip: !hasBash }, async t => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-bash-quoting-"));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const handlers = new Map<string, any>();
    extension({ on: (name: string, handler: any) => handlers.set(name, handler) } as any);
    const ctx: any = { cwd, hasUI: false,
        isProjectTrusted() { throw new Error("Literal read-only commands must skip review"); },
    };
    const words = ["hello", "a b", "x|y", "x;y", "x&&y", "x>file", "$(literal)", "'quoted'", "a\\b", "a*?[b]"];
    let checks = 0;
    for (const word of words) {
        for (const suffix of ["", " | cat", " | head -n 1", " 2>&1 | cat"]) {
            const literal = word.includes("'") ? `"${word}"` : quote(word);
            const command = `echo ${literal}${suffix}`;
            assert.equal(await handlers.get("tool_call")({ toolName: "bash", input: { command } }, ctx), undefined);
            const result = spawnSync("bash", ["--noprofile", "--norc", "-c", command], { cwd, encoding: "utf8", timeout: 5000 });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stdout, word + "\n", command);
            checks++;
        }
    }
    t.diagnostic(`${checks} real Bash quoting and pipeline comparisons`);
});
