import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import extension, { resolveReviewerOverrides } from "../auto-reviewer.ts";

function fixture(t: any): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-integration-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function settings(file: string, autoReviewer: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ autoReviewer }));
}

test("Jev transport settings resolve with the provider/model pair and trust gate", (t) => {
    const cwd = fixture(t);
    const home = fixture(t);
    const user = { provider: "typesafe", model: "jev-latest", backend: "jev" };
    const project = { provider: "gateway", model: "jev", backend: "jev", endpoint: "https://gateway.example/decide", apiKeyEnv: "GATEWAY_KEY" };
    settings(path.join(home, ".pi/agent/settings.json"), user);
    settings(path.join(cwd, ".pi/settings.json"), project);
    assert.deepEqual(resolveReviewerOverrides(cwd, false, {}, home), user);
    assert.deepEqual(resolveReviewerOverrides(cwd, true, {}, home), project);
    assert.deepEqual(resolveReviewerOverrides(cwd, true, {
        PI_REVIEWER_PROVIDER: "openrouter", PI_REVIEWER_MODEL: "typesafe/jev-1.13", PI_REVIEWER_BACKEND: "jev",
    }, home), { provider: "openrouter", model: "typesafe/jev-1.13", backend: "jev" });
    // An orphan transport setting must not attach to a lower layer's credentials.
    assert.deepEqual(resolveReviewerOverrides(cwd, true, {
        PI_REVIEWER_BACKEND: "jev", PI_REVIEWER_ENDPOINT: "https://unrelated.example/decide",
    }, home), project);
    settings(path.join(cwd, ".pi/settings.json"), { ...project, provider: undefined });
    assert.deepEqual(resolveReviewerOverrides(cwd, true, {}, home), user);
    assert.deepEqual(resolveReviewerOverrides(cwd, true, {
        PI_REVIEWER_PROVIDER: "normal", PI_REVIEWER_MODEL: "chat",
    }, home), { provider: "normal", model: "chat" });
});

function install(t: any, cwd: string, getProviderApiKey = async (_provider: string): Promise<string | undefined> => undefined): (command: string) => Promise<any> {
    const keys = ["PI_REVIEWER_PROVIDER", "PI_REVIEWER_MODEL", "PI_REVIEWER_BACKEND", "PI_REVIEWER_ENDPOINT", "PI_REVIEWER_API_KEY_ENV", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "CUSTOM_JEV_KEY"];
    const oldEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const oldFetch = globalThis.fetch;
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, { PI_REVIEWER_PROVIDER: "typesafe", PI_REVIEWER_MODEL: "jev-latest", PI_REVIEWER_BACKEND: "jev", TYPESAFE_API_KEY: "test-key" });
    t.after(() => {
        globalThis.fetch = oldFetch;
        for (const key of keys) {
            if (oldEnv[key] === undefined) delete process.env[key];
            else process.env[key] = oldEnv[key];
        }
    });
    let handler: any;
    extension({ on(name: string, callback: any) { if (name === "tool_call") handler = callback; } } as any);
    return command => handler({ toolName: "bash", input: { command }, toolCallId: "pending" }, {
        cwd, hasUI: false, isProjectTrusted: () => false,
        modelRegistry: { getApiKeyForProvider: getProviderApiKey },
        sessionManager: { getBranch: () => [{ message: { role: "user", content: "Please run the project tests." } }] },
    });
}

function answer(choice: string): Response {
    return Response.json({ answers: { command_review: {
        type: "choice", choice, probabilities: choice === "allow" ? { allow: 0.9, block: 0.1 } : { allow: 0.1, block: 0.9 }, confidence: 0.8,
    } } });
}

test("the extension sends its policy, authorization, and quoted command to Jev", async (t) => {
    const review = install(t, fixture(t));
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        assert.match(body.state, /=== REVIEW RULES ===/);
        assert.match(body.state, /Please run the project tests/);
        assert.match(body.state, /<untrusted_command encoding="json_string">/);
        assert.match(body.state, /npm test/);
        assert.doesNotMatch(body.state, /submit_review|ALLOW:|BLOCK:/);
        return answer("allow");
    };
    assert.equal(await review("npm test"), undefined);
    assert.equal(calls, 1);
    globalThis.fetch = async () => answer("block");
    assert.equal((await review("git reset --hard")).block, true);
    globalThis.fetch = async () => { throw new Error("tier must skip review"); };
    assert.equal(await review("git status"), undefined);
    assert.equal((await review("sudo shutdown")).block, true);
});

test("failed Jev reviews retry once and then block in noninteractive mode", async (t) => {
    const review = install(t, fixture(t));
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({ answers: {} }); };
    const result = await review("npm test");
    assert.equal(calls, 2);
    assert.equal(result.block, true);
    assert.match(result.reason, /failed \(2 attempts\)/);
});

test("a transient Jev failure can recover on the existing retry", async (t) => {
    const review = install(t, fixture(t));
    let calls = 0;
    globalThis.fetch = async () => ++calls === 1 ? new Response("busy", { status: 503 }) : answer("allow");
    assert.equal(await review("npm test"), undefined);
    assert.equal(calls, 2);
});

test("unknown backends fail closed instead of falling through to the pi model", async (t) => {
    const review = install(t, fixture(t));
    process.env.PI_REVIEWER_BACKEND = "typo";
    globalThis.fetch = async () => { throw new Error("must not fetch"); };
    const result = await review("npm test");
    assert.equal(result.block, true);
    assert.match(result.reason, /Unknown reviewer backend/);
});


test("OpenRouter reuses Pi credentials without a separately configured key", async (t) => {
    const lookups: string[] = [];
    const review = install(t, fixture(t), async provider => {
        lookups.push(provider);
        return "saved-router-key";
    });
    process.env.PI_REVIEWER_PROVIDER = "openrouter";
    process.env.PI_REVIEWER_MODEL = "typesafe/jev-1.13";
    globalThis.fetch = async (url, init) => {
        assert.equal(url, "https://openrouter.ai/api/alpha/decisions");
        assert.equal((init?.headers as any).Authorization, "Bearer saved-router-key");
        return answer("allow");
    };
    assert.equal(await review("npm test"), undefined);
    assert.deepEqual(lookups, ["openrouter"]);
});

test("TypeSafe falls back to its saved provider credential", async (t) => {
    const review = install(t, fixture(t), async provider => {
        assert.equal(provider, "typesafe");
        return "saved-typesafe-key";
    });
    delete process.env.TYPESAFE_API_KEY;
    globalThis.fetch = async (_url, init) => {
        assert.equal((init?.headers as any).Authorization, "Bearer saved-typesafe-key");
        return answer("allow");
    };
    assert.equal(await review("npm test"), undefined);
});

test("missing Pi credentials fail closed without sending a request", async (t) => {
    const review = install(t, fixture(t));
    delete process.env.TYPESAFE_API_KEY;
    process.env.PI_REVIEWER_PROVIDER = "openrouter";
    process.env.PI_REVIEWER_MODEL = "typesafe/jev-1.13";
    globalThis.fetch = async () => { assert.fail("must not fetch without credentials"); };
    const result = await review("npm test");
    assert.equal(result.block, true);
    assert.match(result.reason, /credential.*openrouter|openrouter.*credential/i);
});


test("the extension uses a saved credential through Pi's real model registry", async (t) => {
    const dir = fixture(t);
    const review = install(t, dir, provider => registry.getApiKeyForProvider(provider));
    process.env.PI_REVIEWER_PROVIDER = "openrouter";
    process.env.PI_REVIEWER_MODEL = "typesafe/jev-1.13";
    const authPath = path.join(dir, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({ openrouter: { type: "api_key", key: "fixture-saved-key" } }), { mode: 0o600 });
    const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
    const registry = new ModelRegistry(runtime);
    globalThis.fetch = async (_url, init) => {
        assert.equal((init?.headers as any).Authorization, "Bearer fixture-saved-key");
        return answer("allow");
    };
    assert.equal(await review("npm test"), undefined);
    assert.equal(JSON.parse(fs.readFileSync(authPath, "utf8")).openrouter.key, "fixture-saved-key");
});
