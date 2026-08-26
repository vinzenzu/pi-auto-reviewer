/**
 * Structured decision channel for the reviewer subprocess.
 *
 * This file is NOT a user-facing extension — it is never listed in
 * package.json `pi.extensions` and is not registered in the user's main
 * session. The auto-reviewer extension loads it only into the short-lived
 * reviewer subprocess via `pi -e <path>`, where it registers the
 * `submit_review` tool.
 *
 * The reviewer model delivers its verdict as schema-validated tool-call
 * arguments instead of free text, so chain-of-thought leakage into the text
 * channel cannot corrupt decision parsing. `terminate: true` ends the
 * subprocess turn without paying for a follow-up LLM call.
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const submitReview = defineTool({
    name: "submit_review",
    label: "Submit Review",
    description:
        "Submit your final security review decision. This is the ONLY way to deliver your verdict — " +
        "do not write ALLOW or BLOCK as plain text, and do not call any other tool.",
    parameters: Type.Object({
        decision: Type.Union([Type.Literal("allow"), Type.Literal("block")], {
            description: 'The verdict: "allow" to permit the command, "block" to refuse it.',
        }),
        reason: Type.String({
            description: "One short sentence justifying the decision.",
            minLength: 1,
        }),
    }),

    async execute(_toolCallId, params) {
        return {
            content: [{ type: "text", text: `Decision recorded: ${params.decision}.` }],
            terminate: true,
        };
    },
});

export default function (pi: ExtensionAPI) {
    pi.registerTool(submitReview);
}
