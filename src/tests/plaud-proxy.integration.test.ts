/**
 * End-to-end integration test for `plaudFetch` over the wreq-js +
 * Webshare path.
 *
 * Why this exists: unit tests in `plaud-proxy.test.ts` mock both the
 * Webshare API and `wreq-js`, so they can't catch the failure mode that
 * actually shipped — a runtime TLS fingerprint that Cloudflare flags
 * even with a valid residential proxy IP. This file hits real Plaud
 * through a real Webshare proxy from the current Bun runtime, which is
 * the only configuration that reproduces the regression.
 *
 * Opt-in. Skipped unless BOTH env vars are set:
 *   PLAUD_BEARER_TOKEN  — a valid Plaud JWT (any account; we only call
 *                         /team-app/workspaces/list, a read-only endpoint
 *                         that returns the user's own workspaces).
 *   WEBSHARE_API_KEY    — a Webshare account with at least one valid
 *                         residential proxy in its list.
 *
 * Run:
 *   PLAUD_BEARER_TOKEN=eyJ... WEBSHARE_API_KEY=... \
 *     bun test src/tests/plaud-proxy.integration.test.ts
 *
 * What's pinned:
 *   1. The proxied path returns HTTP 200 from Cloudflare-fronted Plaud.
 *      A 403 here means our TLS fingerprint regressed (e.g. the wreq-js
 *      browser profile became stale or the Webshare proxies got flagged).
 *   2. The response body parses as Plaud's standard `{status:0, data:...}`
 *      JSON envelope — i.e. we got real Plaud, not a Cloudflare HTML
 *      challenge masquerading as a 200.
 *   3. Repeated calls succeed. Connection reuse / per-tunnel scoring
 *      doesn't accumulate enough to start flagging us.
 */

import { describe, expect, it, vi } from "vitest";

// Mirror the pattern in `plaud.integration.test.ts`: mock env so importing
// plaudFetch (which transitively pulls `proxy.ts` → `@/lib/env`) doesn't
// trip the DATABASE_URL/ENCRYPTION_KEY runtime checks. The proxy code
// only reads WEBSHARE_API_KEY off env, so passing that through is enough.
const mockEnv = vi.hoisted(() => ({
    WEBSHARE_API_KEY: process.env.WEBSHARE_API_KEY,
}));
vi.mock("@/lib/env", () => ({ env: mockEnv }));

import { plaudFetch } from "@/lib/plaud/fetch";

const bearerToken = process.env.PLAUD_BEARER_TOKEN;
const webshareKey = process.env.WEBSHARE_API_KEY;
const hasCreds =
    typeof bearerToken === "string" &&
    bearerToken.length > 0 &&
    typeof webshareKey === "string" &&
    webshareKey.length > 0;

if (!hasCreds) {
    console.warn(
        "Skipping plaudFetch+Webshare integration tests: set both PLAUD_BEARER_TOKEN and WEBSHARE_API_KEY to run.",
    );
}

const describeIntegration = hasCreds ? describe : describe.skip;

// EU region — chosen because the original 403 reports were all on
// `api-euc1.plaud.ai`. Tests run there to keep the regression surface
// covered. Other regions sit behind the same Cloudflare zone, so a
// passing EU test is a strong indicator they all pass.
const PLAUD_URL =
    "https://api-euc1.plaud.ai/team-app/workspaces/list?need_personal_workspace=true";

async function callPlaud(): Promise<Response> {
    return plaudFetch(PLAUD_URL, {
        headers: {
            Authorization: `Bearer ${bearerToken}`,
            "Content-Type": "application/json",
        },
    });
}

// Real network + Webshare list fetch + native binary load on the cold
// path can comfortably exceed vitest's default 5s. 30s is what the
// existing Plaud integration tests use for similar reasons.
const REAL_NETWORK_TIMEOUT_MS = 30_000;

describeIntegration("plaudFetch through wreq-js + Webshare", () => {
    it(
        "returns HTTP 200 with a real Plaud JSON body",
        async () => {
            const res = await callPlaud();
            expect(res.status).toBe(200);

            // Cloudflare challenge pages return text/html and a body that
            // includes "Attention Required". The real Plaud envelope is
            // application/json with a `status` field. Pin both.
            const ct = res.headers.get("content-type") ?? "";
            expect(ct).toContain("application/json");

            const body = (await res.json()) as { status?: unknown };
            expect(body.status).toBe(0);
        },
        REAL_NETWORK_TIMEOUT_MS,
    );

    it(
        "returns 200 on three consecutive calls (connection reuse stable)",
        async () => {
            for (let i = 0; i < 3; i++) {
                const res = await callPlaud();
                expect(res.status).toBe(200);
                // Drain so the underlying connection is reusable.
                await res.text();
            }
        },
        REAL_NETWORK_TIMEOUT_MS,
    );
});
