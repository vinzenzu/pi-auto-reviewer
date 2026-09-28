import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveJevApiKey } from "../jev-decisions.ts";

const openrouter = { provider: "openrouter", model: "typesafe/jev-1.13" };
const typesafe = { provider: "typesafe", model: "jev-latest" };
const neverLookup = async (): Promise<string | undefined> => { assert.fail("must not resolve a saved credential"); };

test("OpenRouter delegates normal credential precedence to Pi", async () => {
    const calls: string[] = [];
    const key = await resolveJevApiKey(openrouter, async provider => {
        calls.push(provider);
        return "pi-resolved-key";
    }, { OPENROUTER_API_KEY: "different-env-key", TYPESAFE_API_KEY: "unrelated-key" });
    assert.equal(key, "pi-resolved-key");
    assert.deepEqual(calls, ["openrouter"]);
});

test("an explicit key variable overrides a saved credential", async () => {
    assert.equal(await resolveJevApiKey({ ...openrouter, apiKeyEnv: "SEPARATE_KEY" }, neverLookup,
        { SEPARATE_KEY: " separate-key " }), "separate-key");
});

test("a missing explicit override cannot silently fall back", async () => {
    await assert.rejects(resolveJevApiKey({ ...openrouter, apiKeyEnv: "SEPARATE_KEY" }, neverLookup, {}), /SEPARATE_KEY/);
    await assert.rejects(resolveJevApiKey({ ...openrouter, apiKeyEnv: "SEPARATE_KEY" }, neverLookup,
        { SEPARATE_KEY: "   " }), /SEPARATE_KEY/);
});

test("TypeSafe accepts a separate key and otherwise uses its saved provider credential", async () => {
    assert.equal(await resolveJevApiKey(typesafe, neverLookup, { TYPESAFE_API_KEY: "typesafe-key" }), "typesafe-key");
    assert.equal(await resolveJevApiKey(typesafe, async provider => {
        assert.equal(provider, "typesafe");
        return "saved-typesafe";
    }, { TYPESAFE_API_KEY: " " }), "saved-typesafe");
    assert.equal(await resolveJevApiKey({ ...typesafe, apiKeyEnv: "CUSTOM_KEY" }, neverLookup,
        { CUSTOM_KEY: "override", TYPESAFE_API_KEY: "ignored" }), "override");
});

test("a compatible API can reuse its own Pi provider credential", async () => {
    const key = await resolveJevApiKey({ provider: "gateway", model: "jev", endpoint: "https://gateway.example/decide" },
        async provider => { assert.equal(provider, "gateway"); return "gateway-key"; }, {});
    assert.equal(key, "gateway-key");
});

test("missing or empty Pi credentials produce actionable errors", async () => {
    for (const missing of [undefined, "", " "]) {
        await assert.rejects(resolveJevApiKey(openrouter, async () => missing, {}), /No Jev credential for openrouter.*Log in/);
    }
});

test("credential-resolution errors do not disclose resolver output", async () => {
    await assert.rejects(resolveJevApiKey(openrouter, async () => { throw new Error("secret-key or shell output"); }, {}),
        (error: Error) => error.message.includes("through Pi") && !error.message.includes("secret-key"));
});

test("preset credentials are never reused at a different origin", async () => {
    for (const config of [openrouter, typesafe]) {
        for (const endpoint of ["https://other.example/decide", "http://openrouter.ai/api/alpha/decisions", "https://api.typesafe.ai:444/v1/systemone"]) {
            await assert.rejects(resolveJevApiKey({ ...config, endpoint }, neverLookup, { TYPESAFE_API_KEY: "key" }), /explicit apiKeyEnv/);
            assert.equal(await resolveJevApiKey({ ...config, endpoint, apiKeyEnv: "OTHER_KEY" }, neverLookup,
                { OTHER_KEY: "explicit-other-key" }), "explicit-other-key");
        }
    }
    assert.equal(await resolveJevApiKey({ ...openrouter, endpoint: "https://openrouter.ai/api/v1/systemone" },
        async () => "same-origin-key", {}), "same-origin-key");
});

test("cancellation stops waiting for provider credentials", async () => {
    const controller = new AbortController();
    const pending = resolveJevApiKey(openrouter, async () => {
        controller.abort(new Error("Review aborted"));
        return new Promise(() => {});
    }, {}, controller.signal);
    let timer: ReturnType<typeof setTimeout>;
    try {
        await assert.rejects(Promise.race([
            pending,
            new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Cancellation ignored")), 50); }),
        ]), /Review aborted/);
    } finally {
        clearTimeout(timer!);
    }
});

test("an already cancelled review does not resolve provider credentials", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Review aborted"));
    await assert.rejects(resolveJevApiKey(openrouter, neverLookup, {}, controller.signal), /Review aborted/);
});
