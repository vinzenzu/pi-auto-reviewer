import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as reviewer from "../auto-reviewer.ts";

function fixture(t: any): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-denial-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function configuredReview(t: any, mode: string, options: { hasUI?: boolean; choice?: string; cancel?: boolean; aborted?: boolean } = {}) {
    const cwd = fixture(t);
    const keys = ["PI_REVIEWER_PROVIDER", "PI_REVIEWER_MODEL", "PI_REVIEWER_BACKEND", "PI_REVIEWER_ENDPOINT", "PI_REVIEWER_API_KEY_ENV", "PI_REVIEWER_ON_DENY", "TYPESAFE_API_KEY"];
    const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const fetch = globalThis.fetch;
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, { PI_REVIEWER_PROVIDER: "typesafe", PI_REVIEWER_MODEL: "jev-latest", PI_REVIEWER_BACKEND: "jev", PI_REVIEWER_ON_DENY: mode, TYPESAFE_API_KEY: "test-key" });
    t.after(() => {
        globalThis.fetch = fetch;
        for (const key of keys) {
            if (original[key] === undefined) delete process.env[key];
            else process.env[key] = original[key];
        }
    });
    let requests = 0;
    const prompts: any[] = [];
    const events: any[] = [];
    const handlers = new Map<string, any>();
    globalThis.fetch = async () => {
        requests++;
        return Response.json({ answers: { command_review: {
            type: "choice", choice: "block", probabilities: { allow: 0.1, block: 0.9 }, confidence: 0.9,
        } } });
    };
    reviewer.default({
        on: (name: string, handler: any) => handlers.set(name, handler),
        appendEntry() {}, events: { emit: (name: string, data: any) => events.push({ name, data }) },
    } as any);
    const controller = new AbortController();
    const ctx: any = {
        signal: controller.signal,
        cwd, hasUI: options.hasUI ?? false, isProjectTrusted: () => false,
        sessionManager: { getSessionId: () => "denial-session", appendUsage() {}, getBranch: () => [] },
        modelRegistry: { getApiKeyForProvider: async () => "test-key" },
        ui: { setStatus() {}, notify() {}, select: async (title: string, choices: string[]) => {
            prompts.push({ title, choices });
            if (options.aborted) controller.abort();
            if (options.cancel) throw new Error("dialog cancelled");
            return options.choice;
        } },
    };
    return { events, prompts,
        get requests() { return requests; },
        review: (command = "git reset --hard HEAD^", id = "denied-call") => handlers.get("tool_call")({ toolName: "bash", toolCallId: id, input: { command } }, ctx),
    };
}

test("agent mode returns a rejection for recovery without executing or manually allowing it", async t => {
    const h = configuredReview(t, "agent", { hasUI: true, choice: "Allow once" });
    const result = await h.review();
    assert.equal(result.block, true);
    assert.match(result.reason, /not executed/i);
    assert.match(result.reason, /new evidence|safer/i);
    assert.equal(h.prompts.length, 0);
    assert.equal(h.requests, 1);
    assert.deepEqual(h.events.filter(e => e.name === "pi-auto-reviewer:denial").map(e => e.data), [{
        sessionId: "denial-session", toolCallId: "denied-call", handling: "agent",
    }]);
});

test("manual mode allows exactly the displayed command only after explicit user confirmation", async t => {
    const h = configuredReview(t, "manual", { hasUI: true, choice: "Allow once" });
    assert.equal(await h.review(), undefined);
    assert.equal(h.prompts.length, 1);
    assert.match(h.prompts[0].title, /git reset --hard HEAD\^/);
    assert.deepEqual(h.prompts[0].choices, ["Block", "Allow once"]);
    assert.equal(h.events.filter(e => e.name === "pi-auto-reviewer:denial").length, 0);
    await h.review("git reset --hard HEAD", "another-call");
    assert.equal(h.prompts.length, 2);
});

test("manual decline stays blocked and emits a nonrecoverable denial", async t => {
    const h = configuredReview(t, "manual", { hasUI: true, choice: "Block" });
    assert.equal((await h.review()).block, true);
    assert.equal(h.requests, 1);
    assert.equal(h.events.find(e => e.name === "pi-auto-reviewer:denial").data.handling, "manual");
});

test("manual mode without a UI fails closed", async t => {
    const h = configuredReview(t, "manual");
    assert.equal((await h.review()).block, true);
    assert.equal(h.prompts.length, 0);
});

test("cancelled manual review blocks without rerunning the model review", async t => {
    const h = configuredReview(t, "manual", { hasUI: true, cancel: true });
    assert.equal((await h.review()).block, true);
    assert.equal(h.requests, 1);
    assert.equal(h.prompts.length, 1);
});

test("manual approval after cancellation cannot allow the command", async t => {
    const h = configuredReview(t, "manual", { hasUI: true, choice: "Allow once", aborted: true });
    assert.equal((await h.review()).block, true);
    assert.equal(h.requests, 1);
});

test("hard blocks cannot be overridden by manual mode", async t => {
    const h = configuredReview(t, "manual", { hasUI: true, choice: "Allow once" });
    const result = await h.review("sudo shutdown");
    assert.equal(result.block, true);
    assert.match(result.reason, /Auto-blocked/);
    assert.equal(h.requests, 0);
    assert.equal(h.prompts.length, 0);
});

test("block mode preserves the existing denial behavior", async t => {
    const h = configuredReview(t, "block", { hasUI: true, choice: "Allow once" });
    const result = await h.review();
    assert.equal(result.block, true);
    assert.match(result.reason, /^Auto-reviewer blocked:/);
    assert.equal(h.prompts.length, 0);
});

test("denial policy resolves independently of provider settings and honors project trust", t => {
    const cwd = fixture(t), home = fixture(t);
    const write = (file: string, value: unknown) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ autoReviewer: value }));
    };
    const resolve = (reviewer as any).resolveDenialHandling;
    assert.equal(typeof resolve, "function");
    assert.equal(resolve(cwd, true, {}, home), "block");
    write(path.join(home, ".pi/agent/settings.json"), { onDeny: "manual" });
    write(path.join(cwd, ".pi/settings.json"), { onDeny: "agent" });
    assert.equal(resolve(cwd, false, {}, home), "manual");
    assert.equal(resolve(cwd, true, {}, home), "agent");
    assert.equal(resolve(cwd, true, { PI_REVIEWER_ON_DENY: "block" }, home), "block");
    assert.equal(resolve(cwd, true, { PI_REVIEWER_ON_DENY: "typo" }, home), "block");
    write(path.join(cwd, ".pi/settings.json"), { onDeny: "typo" });
    assert.equal(resolve(cwd, true, {}, home), "block");
});
