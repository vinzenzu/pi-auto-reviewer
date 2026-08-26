import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveReviewerOverrides } from "../auto-reviewer.ts";

function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "pi-reviewer-test-"));
}

function writeSettings(dir: string, settings: unknown): void {
    fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".pi", "settings.json"), JSON.stringify(settings));
}

test("no configuration anywhere → empty overrides", () => {
    const cwd = tempDir();
    const home = tempDir();
    const r = resolveReviewerOverrides(cwd, false, {}, home);
    assert.deepEqual(r, {});
});

test("env pair wins over settings", () => {
    const cwd = tempDir();
    writeSettings(cwd, { autoReviewer: { provider: "settings-provider", model: "settings-model" } });
    const r = resolveReviewerOverrides(cwd, true, { PI_REVIEWER_PROVIDER: "env-provider", PI_REVIEWER_MODEL: "env-model" }, tempDir());
    assert.deepEqual(r, { provider: "env-provider", model: "env-model" });
});

test("partial env pair is ignored, falls through to trusted project pair", () => {
    const cwd = tempDir();
    writeSettings(cwd, { autoReviewer: { provider: "proj-provider", model: "proj-model" } });
    const r = resolveReviewerOverrides(cwd, true, { PI_REVIEWER_MODEL: "orphan-model" }, tempDir());
    assert.deepEqual(r, { provider: "proj-provider", model: "proj-model" });
});

test("untrusted project settings are ignored, user pair used", () => {
    const cwd = tempDir();
    writeSettings(cwd, { autoReviewer: { provider: "proj-provider", model: "proj-model" } });
    const home = tempDir();
    writeSettings(path.join(home, ".pi", "agent"), { autoReviewer: { provider: "user-provider", model: "user-model" } });
    // user settings already written via .pi/agent path; rewrite correctly:
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(
        path.join(home, ".pi", "agent", "settings.json"),
        JSON.stringify({ autoReviewer: { provider: "user-provider", model: "user-model" } }),
    );
    const r = resolveReviewerOverrides(cwd, false, {}, home);
    assert.deepEqual(r, { provider: "user-provider", model: "user-model" });
});

test("trusted project pair wins over user pair", () => {
    const cwd = tempDir();
    writeSettings(cwd, { autoReviewer: { provider: "proj-provider", model: "proj-model" } });
    const home = tempDir();
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(
        path.join(home, ".pi", "agent", "settings.json"),
        JSON.stringify({ autoReviewer: { provider: "user-provider", model: "user-model" } }),
    );
    const r = resolveReviewerOverrides(cwd, true, {}, home);
    assert.deepEqual(r, { provider: "proj-provider", model: "proj-model" });
});

test("partial project pair is ignored — no cross-layer mixing", () => {
    const cwd = tempDir();
    writeSettings(cwd, { autoReviewer: { model: "proj-model-only" } });
    const home = tempDir();
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(
        path.join(home, ".pi", "agent", "settings.json"),
        JSON.stringify({ autoReviewer: { provider: "user-provider", model: "user-model" } }),
    );
    const r = resolveReviewerOverrides(cwd, true, {}, home);
    assert.deepEqual(r, { provider: "user-provider", model: "user-model" });
});

test("malformed settings JSON is ignored", () => {
    const cwd = tempDir();
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), "{ not json");
    const r = resolveReviewerOverrides(cwd, true, {}, tempDir());
    assert.deepEqual(r, {});
});

test("autoReviewer object with non-string fields is ignored", () => {
    const cwd = tempDir();
    writeSettings(cwd, { autoReviewer: { provider: 42, model: "some-model" } });
    const r = resolveReviewerOverrides(cwd, true, {}, tempDir());
    assert.deepEqual(r, {});
});
