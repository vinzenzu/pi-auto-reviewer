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

function configuredReview(t: any, mode: string, options: { hasUI?: boolean; choice?: string; cancel?: boolean; aborted?: boolean; preAborted?: boolean; takeFirstChoice?: boolean; denialEmitThrows?: boolean; allowOnRetry?: boolean; failReview?: boolean; failureMode?: string } = {}) {
    const cwd = fixture(t);
    const keys = ["PI_REVIEWER_PROVIDER", "PI_REVIEWER_MODEL", "PI_REVIEWER_BACKEND", "PI_REVIEWER_ENDPOINT", "PI_REVIEWER_API_KEY_ENV", "PI_REVIEWER_ON_DENY", "PI_REVIEWER_ON_REVIEW_FAILURE", "TYPESAFE_API_KEY"];
    const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const fetch = globalThis.fetch;
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, { PI_REVIEWER_PROVIDER: "typesafe", PI_REVIEWER_MODEL: "jev-latest", PI_REVIEWER_BACKEND: "jev", PI_REVIEWER_ON_DENY: mode, TYPESAFE_API_KEY: "test-key" });
    if (options.failureMode !== undefined) process.env.PI_REVIEWER_ON_REVIEW_FAILURE = options.failureMode;
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
    const notifications: string[] = [];
    const handlers = new Map<string, any>();
    globalThis.fetch = async (input: any, init?: any) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
        if (typeof url === "string" && /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) return fetch(input, init);
        requests++;
        if (options.failReview) return new Response("no", { status: 500 });
        const choice = options.allowOnRetry && requests > 1 ? "allow" : "block";
        const allow = choice === "allow";
        return Response.json({ answers: { command_review: {
            type: "choice", choice, confidence: 0.9,
            probabilities: allow ? { allow: 0.9, block: 0.1 } : { allow: 0.1, block: 0.9 },
        } } });
    };
    reviewer.default({
        on: (name: string, handler: any) => handlers.set(name, handler),
        appendEntry() {}, events: { emit: (name: string, data: any) => {
            events.push({ name, data });
            if (options.denialEmitThrows && name === "pi-auto-reviewer:denial") throw new Error("denial delivery failed");
        } },
    } as any);
    const controller = new AbortController();
    if (options.preAborted) controller.abort();
    const ctx: any = {
        signal: controller.signal,
        cwd, hasUI: options.hasUI ?? false, isProjectTrusted: () => false,
        sessionManager: { getSessionId: () => "denial-session", appendUsage() {}, getBranch: () => [] },
        modelRegistry: { getApiKeyForProvider: async () => "test-key" },
        ui: { setStatus() {}, notify(message: string) { notifications.push(String(message)); }, select: async (title: string, choices: string[]) => {
            prompts.push({ title, choices });
            if (options.aborted) controller.abort();
            if (options.cancel) throw new Error("dialog cancelled");
            if (options.takeFirstChoice) return choices[0];
            return options.choice;
        } },
    };
    return { events, prompts, notifications,
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
    assert.equal(result.terminate, undefined);
    assert.deepEqual(h.events.filter(e => e.name === "pi-auto-reviewer:denial").map(e => e.data), [{
        sessionId: "denial-session", toolCallId: "denied-call", handling: "agent", cause: "denied",
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

test("manual decline stays blocked and emits no denial event", async t => {
    const h = configuredReview(t, "manual", { hasUI: true, choice: "Block" });
    const result = await h.review();
    assert.equal(result.block, true);
    assert.equal(result.terminate, true);
    assert.equal(h.requests, 1);
    assert.equal(h.events.filter(e => e.name === "pi-auto-reviewer:denial").length, 0);
});

test("manual mode without a UI fails closed", async t => {
    const h = configuredReview(t, "manual");
    const result = await h.review();
    assert.equal(result.block, true);
    assert.equal(result.terminate, true);
    assert.equal(h.prompts.length, 0);
});

test("cancelled manual review blocks without rerunning the model review", async t => {
    const h = configuredReview(t, "manual", { hasUI: true, cancel: true });
    const result = await h.review();
    assert.equal(result.block, true);
    assert.equal(result.terminate, true);
    assert.equal(h.requests, 1);
    assert.equal(h.prompts.length, 1);
});

test("manual approval after cancellation cannot allow the command", async t => {
    const h = configuredReview(t, "manual", { hasUI: true, choice: "Allow once", aborted: true });
    const result = await h.review();
    assert.equal(result.block, true);
    assert.equal(result.terminate, true);
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

test("a denial delivery failure stays blocked and does not review again", async t => {
    const h = configuredReview(t, "agent", { hasUI: true, denialEmitThrows: true, allowOnRetry: true });
    const result = await h.review();
    assert.equal(result.block, true);
    assert.equal(result.terminate, undefined);
    assert.match(result.reason, /^Auto-reviewer blocked:/);
    assert.equal(h.requests, 1);
    assert.equal(h.prompts.length, 0);
});

test("block mode preserves the existing denial behavior", async t => {
    const h = configuredReview(t, "block", { hasUI: true, choice: "Allow once" });
    const result = await h.review();
    assert.equal(result.block, true);
    assert.equal(result.terminate, true);
    assert.match(result.reason, /^Auto-reviewer blocked:/);
    assert.equal(h.prompts.length, 0);
    assert.equal(h.events.filter(e => e.name === "pi-auto-reviewer:denial").length, 0);
});

test("denial policy resolves independently of provider settings and honors project trust", t => {
    const cwd = fixture(t), home = fixture(t);
    const write = (file: string, value: unknown) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ autoReviewer: value }));
    };
    const resolve = (reviewer as any).resolveDenialHandling;
    assert.equal(typeof resolve, "function");
    assert.equal(resolve(cwd, true, {}, home), "agent");
    write(path.join(home, ".pi/agent/settings.json"), { onDeny: "manual" });
    write(path.join(cwd, ".pi/settings.json"), { onDeny: "agent" });
    assert.equal(resolve(cwd, false, {}, home), "manual");
    assert.equal(resolve(cwd, true, {}, home), "agent");
    assert.equal(resolve(cwd, true, { PI_REVIEWER_ON_DENY: "block" }, home), "block");
    assert.equal(resolve(cwd, true, { PI_REVIEWER_ON_DENY: "typo" }, home), "agent");
    write(path.join(cwd, ".pi/settings.json"), { onDeny: "typo" });
    assert.equal(resolve(cwd, true, {}, home), "agent");
});

test("a failed review in block mode asks Block first and stopping ends the turn", async t => {
    const h = configuredReview(t, "block", { hasUI: true, takeFirstChoice: true, failReview: true });
    const result = await h.review();
    assert.deepEqual(h.prompts.map(prompt => prompt.choices), [["Block", "Allow once"]]);
    assert.match(h.prompts[0].title, /Auto-review failed \(2 attempts\)/);
    assert.equal(result.block, true);
    assert.equal(result.terminate, true);
    assert.match(result.reason, /^Auto-review failed \(2 attempts\):/);
    assert.match(result.reason, /not executed/i);
    assert.equal(h.events.filter(e => e.name === "pi-auto-reviewer:denial").length, 0);
    assert.equal(h.requests, 2);
});

test("a failed review in block mode runs the command only after Allow once", async t => {
    const h = configuredReview(t, "block", { hasUI: true, choice: "Allow once", failReview: true });
    assert.equal(await h.review(), undefined);
    assert.equal(h.events.filter(e => e.name === "pi-auto-reviewer:denial").length, 0);
});

test("a failed review in agent mode skips the dialog and tells the agent to continue", async t => {
    const h = configuredReview(t, "agent", { hasUI: true, choice: "Allow once", failReview: true });
    const result = await h.review();
    assert.equal(h.prompts.length, 0);
    assert.equal(result.block, true);
    assert.equal(result.terminate, undefined);
    assert.match(result.reason, /could not be reached/i);
    assert.match(result.reason, /safety judgment/i);
    assert.deepEqual(h.events.filter(e => e.name === "pi-auto-reviewer:denial").map(e => e.data), [{
        sessionId: "denial-session", toolCallId: "denied-call", handling: "agent", cause: "failed",
    }]);
});

test("a failed review in manual mode uses the same Block and Allow once choices", async t => {
    const h = configuredReview(t, "manual", { hasUI: true, choice: "Allow once", failReview: true });
    assert.equal(await h.review(), undefined);
    assert.deepEqual(h.prompts.map(prompt => prompt.choices), [["Block", "Allow once"]]);
    assert.equal(h.events.filter(e => e.name === "pi-auto-reviewer:denial").length, 0);
});

test("a failed review without a UI stays stopped and only block and manual end the turn", async t => {
    for (const mode of ["block", "manual", "agent"]) {
        const h = configuredReview(t, mode, { failReview: true });
        const result = await h.review();
        assert.equal(result.block, true, mode);
        assert.equal(h.prompts.length, 0, mode);
        assert.equal(result.terminate, mode === "agent" ? undefined : true, mode);
        assert.equal(h.events.filter(e => e.name === "pi-auto-reviewer:denial").length, mode === "agent" ? 1 : 0, mode);
    }
});

test("an already aborted review is a cancellation, not a failed review", async t => {
    for (const mode of ["manual", "block"]) {
        const h = configuredReview(t, mode, { hasUI: true, choice: "Allow once", failReview: true, preAborted: true });
        const result = await h.review();
        assert.equal(result.block, true, mode);
        assert.equal(result.terminate, undefined, mode);
        assert.match(result.reason, /cancelled/i, mode);
        assert.doesNotMatch(result.reason, /could not be reached/i, mode);
        assert.equal(h.prompts.length, 0, mode);
        assert.equal(h.requests, 0, mode);
        assert.equal(h.notifications.some(message => message.includes("attempt")), false, mode);
        assert.equal(h.events.filter(e => e.name === "pi-auto-reviewer:denial").length, 0, mode);
    }
});

test("an already aborted review in agent mode does not continue the cancelled work", async t => {
    const h = configuredReview(t, "agent", { hasUI: true, preAborted: true });
    const result = await h.review();
    assert.equal(result.block, true);
    assert.equal(result.terminate, undefined);
    assert.match(result.reason, /cancelled/i);
    assert.doesNotMatch(result.reason, /could not be reached/i);
    assert.equal(h.prompts.length, 0);
    assert.equal(h.requests, 0);
    assert.equal(h.notifications.some(message => message.includes("attempt")), false);
    assert.equal(h.events.filter(e => e.name === "pi-auto-reviewer:denial").length, 0);
});

test("a cancelled failure dialog stays blocked and ends the turn", async t => {
    const h = configuredReview(t, "manual", { hasUI: true, cancel: true, failReview: true });
    const result = await h.review();
    assert.equal(result.block, true);
    assert.equal(result.terminate, true);
    assert.equal(h.prompts.length, 1);
});

test("follow-onDeny skips the failure dialog in block mode and still asks in manual mode", async t => {
    const blocked = configuredReview(t, "block", { hasUI: true, choice: "Allow once", failReview: true, failureMode: "follow-onDeny" });
    const blockedResult = await blocked.review();
    assert.equal(blocked.prompts.length, 0);
    assert.equal(blockedResult.block, true);
    assert.equal(blockedResult.terminate, true);
    assert.equal(blocked.events.filter(e => e.name === "pi-auto-reviewer:denial").length, 0);

    const manual = configuredReview(t, "manual", { hasUI: true, choice: "Allow once", failReview: true, failureMode: "follow-onDeny" });
    assert.equal(await manual.review(), undefined);
    assert.deepEqual(manual.prompts.map(prompt => prompt.choices), [["Block", "Allow once"]]);

    const agent = configuredReview(t, "agent", { hasUI: true, choice: "Allow once", failReview: true, failureMode: "ask" });
    const agentResult = await agent.review();
    assert.equal(agent.prompts.length, 0);
    assert.equal(agentResult.block, true);
    assert.equal(agentResult.terminate, undefined);
});

test("review failure policy resolves independently of denial policy and honors project trust", t => {
    const cwd = fixture(t), home = fixture(t);
    const write = (file: string, value: unknown) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ autoReviewer: value }));
    };
    const resolve = (reviewer as any).resolveReviewFailureHandling;
    assert.equal(typeof resolve, "function");
    assert.equal(resolve(cwd, true, {}, home), "ask");
    write(path.join(home, ".pi/agent/settings.json"), { onReviewFailure: "follow-onDeny", onDeny: "manual" });
    write(path.join(cwd, ".pi/settings.json"), { onReviewFailure: "ask" });
    assert.equal(resolve(cwd, false, {}, home), "follow-onDeny");
    assert.equal(resolve(cwd, true, {}, home), "ask");
    assert.equal(resolve(cwd, true, { PI_REVIEWER_ON_REVIEW_FAILURE: "follow-onDeny", PI_REVIEWER_ON_DENY: "agent" }, home), "follow-onDeny");
    assert.equal(resolve(cwd, true, { PI_REVIEWER_ON_REVIEW_FAILURE: "typo" }, home), "ask");
    write(path.join(cwd, ".pi/settings.json"), { onReviewFailure: "typo" });
    assert.equal(resolve(cwd, true, {}, home), "ask");
});
