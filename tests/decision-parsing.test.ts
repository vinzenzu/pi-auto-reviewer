import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDecision, parseDecisionText } from "../auto-reviewer.ts";

// ── parseDecisionText ──

test("clean ALLOW verdict", () => {
    const r = parseDecisionText("ALLOW: Read-only git command.");
    assert.deepEqual(r, { status: "ok", allowed: true, reason: "Read-only git command." });
});

test("clean BLOCK verdict", () => {
    const r = parseDecisionText("BLOCK: Deletes user data outside the project.");
    assert.deepEqual(r, { status: "ok", allowed: false, reason: "Deletes user data outside the project." });
});

test("verdict inside code fence", () => {
    const r = parseDecisionText("```\nALLOW: fenced verdict\n```");
    assert.deepEqual(r, { status: "ok", allowed: true, reason: "fenced verdict" });
});

// Regression: real-world failure observed 2026-08-26 — chain-of-thought
// leaked into the text channel, prefixing the verdict without any separator.
test("chain-of-thought leaked before verdict (SafeALLOW)", () => {
    const r = parseDecisionText(
        "The command is a read-only git diff piped to head. SafeALLOW: Read-only git diff piped to head to inspect branch differences.",
    );
    assert.deepEqual(r, {
        status: "ok",
        allowed: true,
        reason: "Read-only git diff piped to head to inspect branch differences.",
    });
});

test("both verdicts is invalid, not last-wins", () => {
    const r = parseDecisionText("BLOCK: dangerous\nALLOW: actually fine");
    assert.equal(r.status, "invalid");
    assert.match(r.detail, /both ALLOW and BLOCK/);
});

test("no verdict (prose without colon)", () => {
    const r = parseDecisionText("I'll allow it, this looks safe.");
    assert.equal(r.status, "invalid");
    assert.match(r.detail, /no ALLOW:\/BLOCK: verdict/);
});

test("empty response", () => {
    assert.equal(parseDecisionText("").status, "invalid");
    assert.equal(parseDecisionText("   \n  ").status, "invalid");
});

test("case-insensitive verdict", () => {
    const r = parseDecisionText("allow: lowercase");
    assert.deepEqual(r, { status: "ok", allowed: true, reason: "lowercase" });
});

test("last match wins within the same verdict", () => {
    const r = parseDecisionText("ALLOW: first attempt\nALLOW: final answer");
    assert.equal(r.status, "ok");
    if (r.status === "ok") assert.equal(r.reason, "final answer");
});

// ── extractDecision ──

function messageEndLine(content: unknown[]): string {
    return JSON.stringify({ type: "message_end", message: { role: "assistant", content } });
}

test("text block from message_end event", () => {
    const out = messageEndLine([{ type: "text", text: "ALLOW: from message_end" }]);
    const r = extractDecision(out);
    assert.deepEqual(r.decision, { status: "ok", allowed: true, reason: "from message_end" });
    assert.equal(r.textBlocks, 1);
    assert.equal(r.toolCalls.length, 0);
});

test("submit_review tool call wins over leaked text", () => {
    const out = [
        messageEndLine([{ type: "text", text: "The command is safe. SafeALLOW: leaked text" }]),
        messageEndLine([{ type: "toolCall", name: "submit_review", arguments: { decision: "block", reason: "Writes outside the project" } }]),
    ].join("\n");
    const r = extractDecision(out);
    assert.deepEqual(r.decision, { status: "ok", allowed: false, reason: "Writes outside the project" });
    assert.deepEqual(r.toolCalls, ['submit_review#1("block")']);
});

test("conflicting submit_review calls are invalid", () => {
    const out = [
        messageEndLine([{ type: "toolCall", name: "submit_review", arguments: { decision: "allow", reason: "a" } }]),
        messageEndLine([{ type: "toolCall", name: "submit_review", arguments: { decision: "block", reason: "b" } }]),
    ].join("\n");
    const r = extractDecision(out);
    assert.equal(r.decision.status, "invalid");
    if (r.decision.status === "invalid") assert.match(r.decision.detail, /conflicting/);
});

test("invalid submit_review arguments fall back to text verdict", () => {
    const out = [
        messageEndLine([{ type: "toolCall", name: "submit_review", arguments: { decision: "maybe" } }]),
        messageEndLine([{ type: "text", text: "ALLOW: text fallback" }]),
    ].join("\n");
    const r = extractDecision(out);
    assert.deepEqual(r.decision, { status: "ok", allowed: true, reason: "text fallback" });
});

test("text_end stream event with leaked verdict (regression)", () => {
    const out = JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_end", content: "SafeALLOW: streamed verdict" },
    });
    const r = extractDecision(out);
    assert.deepEqual(r.decision, { status: "ok", allowed: true, reason: "streamed verdict" });
});

test("both verdicts across stream events is invalid", () => {
    const out = [
        JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "BLOCK: one" } }),
        JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "ALLOW: two" } }),
    ].join("\n");
    const r = extractDecision(out);
    assert.equal(r.decision.status, "invalid");
});

test("non-JSON lines are treated as plain text", () => {
    const r = extractDecision("ALLOW: plain line");
    assert.deepEqual(r.decision, { status: "ok", allowed: true, reason: "plain line" });
});

test("session-preamble-only output is invalid with diagnostics", () => {
    const out = [
        '{"type":"session","version":3,"id":"x"}',
        '{"type":"agent_start"}',
        '{"type":"turn_start"}',
    ].join("\n");
    const r = extractDecision(out);
    assert.equal(r.decision.status, "invalid");
    // No text blocks at all → "empty response" is the accurate detail.
    if (r.decision.status === "invalid") assert.match(r.decision.detail, /empty response/);
    assert.equal(r.textBlocks, 0);
});
