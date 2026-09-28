import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { requestJevReview } from "../jev-decisions.ts";

const config = { provider: "typesafe", model: "jev-latest" };
const validAnswer = {
    type: "choice", choice: "allow",
    probabilities: { allow: 0.9, block: 0.1 }, confidence: 0.8,
};

function response(answer: unknown = validAnswer): Response {
    return Response.json({ answers: { command_review: answer } });
}

test("TypeSafe receives the native decisions schema and bearer key", async () => {
    let request: any;
    const result = await requestJevReview(config, "review state", 1000, undefined,
        "test-key", async (url, init) => {
            request = { url, ...init, body: JSON.parse(String(init?.body)) };
            return response();
        });
    assert.equal(request.url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.Authorization, "Bearer test-key");
    assert.equal(request.redirect, "error");
    assert.equal(request.body.model, "jev-latest");
    assert.equal(request.body.state, "review state");
    assert.equal(request.body.questions.command_review.type, "choice");
    assert.deepEqual(Object.keys(request.body.questions.command_review.criteria), ["allow", "block"]);
    assert.equal(result.decision.allowed, true);
});

test("OpenRouter uses its Decisions endpoint and key", async () => {
    const result = await requestJevReview({ provider: "openrouter", model: "typesafe/jev-1.13" },
        "state", 1000, undefined, "router-key", async (url, init) => {
            assert.equal(url, "https://openrouter.ai/api/alpha/decisions");
            assert.equal((init?.headers as any).Authorization, "Bearer router-key");
            assert.equal(JSON.parse(String(init?.body)).model, "typesafe/jev-1.13");
            return response({ ...validAnswer, choice: "block", probabilities: { allow: 0.1, block: 0.9 } });
        });
    assert.equal(result.decision.allowed, false);
});

test("compatible APIs use an exact endpoint and named credential", async () => {
    await requestJevReview({ provider: "gateway", model: "jev", endpoint: "https://gateway.example/decide", apiKeyEnv: "GATEWAY_KEY" },
        "state", 1000, undefined, "gateway-key", async (url, init) => {
            assert.equal(url, "https://gateway.example/decide");
            assert.equal((init?.headers as any).Authorization, "Bearer gateway-key");
            return response();
        });
});

test("missing credentials and unknown providers fail before sending", async () => {
    const neverFetch = async () => { throw new Error("must not fetch"); };
    await assert.rejects(requestJevReview(config, "state", 1000, undefined, "", neverFetch), /API key/);
    await assert.rejects(requestJevReview({ provider: "unknown", model: "jev" }, "state", 1000, undefined, "key", neverFetch), /endpoint/);
});

test("malformed, unknown, and inconsistent answers cannot allow commands", async () => {
    for (const answer of [null, {}, { ...validAnswer, type: "noul" },
        { ...validAnswer, choice: "ALLOW" },
        { ...validAnswer, choice: ["block"], probabilities: { allow: 0.1, block: 0.9 } }, { ...validAnswer, confidence: "0.8" },
        { ...validAnswer, confidence: 2 }, { ...validAnswer, probabilities: {} },
        { ...validAnswer, probabilities: { allow: 0.2, block: 0.8 } },
        { ...validAnswer, probabilities: { allow: 0.5, block: 0.5 } },
        { ...validAnswer, probabilities: { allow: 0.9, block: 0.8 } }]) {
        await assert.rejects(requestJevReview(config, "state", 1000, undefined,
            "key", async () => response(answer)), /invalid/i);
    }
    for (const body of [{}, { answers: {} }, { answers: { other: validAnswer } }]) {
        await assert.rejects(requestJevReview(config, "state", 1000, undefined,
            "key", async () => Response.json(body)), /invalid/i);
    }
});

test("HTTP and JSON failures do not expose provider response bodies", async () => {
    await assert.rejects(requestJevReview(config, "state", 1000, undefined,
        "key", async () => new Response("sensitive provider error", { status: 401 })),
        (error: Error) => error.message.includes("401") && !error.message.includes("sensitive"));
    await assert.rejects(requestJevReview(config, "state", 1000, undefined,
        "key", async () => new Response("not JSON")), /JSON/);
});

test("caller cancellation and timeout abort the HTTP request", async () => {
    const hangingFetch: typeof fetch = async (_url, init) => {
        const signal = init!.signal!;
        signal.throwIfAborted();
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    };
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(requestJevReview(config, "state", 1000, controller.signal,
        "key", hangingFetch), /abort/i);
    // Keep the event loop alive because AbortSignal.timeout uses an unref'd timer.
    const keepAlive = setTimeout(() => {}, 1000);
    try {
        await assert.rejects(requestJevReview(config, "state", 10, undefined,
            "key", hangingFetch), /timeout/i);
    } finally {
        clearTimeout(keepAlive);
    }
});


test("the HTTP driver interoperates with a compatible server and refuses redirects", async () => {
    const received: string[] = [];
    const server = createServer(async (req, res) => {
        received.push(req.url!);
        if (req.url === "/redirect") {
            res.writeHead(307, { Location: "/unexpected" });
            res.end();
            return;
        }
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        assert.equal(req.method, "POST");
        assert.equal(req.headers.authorization, "Bearer local-key");
        assert.equal(body.questions.command_review.type, "choice");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ answers: { command_review: validAnswer } }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as { port: number };
    const endpoint = `http://127.0.0.1:${address.port}`;
    try {
        const result = await requestJevReview({ ...config, endpoint: `${endpoint}/decide` }, "state", 1000,
            undefined, "local-key");
        assert.equal(result.decision.allowed, true);
        await assert.rejects(requestJevReview({ ...config, endpoint: `${endpoint}/redirect` }, "state", 1000,
            undefined, "local-key"));
        assert.deepEqual(received, ["/decide", "/redirect"]);
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
