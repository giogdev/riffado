import { PostHog } from "posthog-node";
import { env } from "@/lib/env";

/**
 * Server-side PostHog client. Hard-gated on `IS_HOSTED` -- self-host
 * deployments never construct a client, even if `POSTHOG_KEY` happens
 * to be set, matching the client-side gate in
 * `src/components/posthog-analytics.tsx`.
 */
let posthogClient: PostHog | null = null;

export function getPostHogClient(): PostHog | null {
    if (!env.IS_HOSTED || !env.POSTHOG_KEY) return null;

    if (!posthogClient) {
        posthogClient = new PostHog(env.POSTHOG_KEY, {
            host: env.POSTHOG_HOST ?? "https://eu.i.posthog.com",
            flushAt: 1,
            flushInterval: 0,
        });
    }
    return posthogClient;
}

interface CaptureServerEventOptions {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
}

/**
 * Capture a server-side event and flush immediately. No-ops when
 * PostHog isn't configured for this deployment -- callers don't need
 * to guard on `getPostHogClient()` themselves.
 *
 * `flush()` failures (PostHog network hiccup) are swallowed, not
 * rethrown -- every call site awaits this on an already-successful
 * action (transcription completed, sync succeeded, provider added,
 * etc.), and a transient analytics-ingest failure must never turn that
 * success into a 500 for the user.
 */
export async function captureServerEvent({
    distinctId,
    event,
    properties,
}: CaptureServerEventOptions): Promise<void> {
    const client = getPostHogClient();
    if (!client) return;
    client.capture({ distinctId, event, properties });
    try {
        await client.flush();
    } catch (flushError) {
        console.error("[posthog] failed to flush event:", flushError);
    }
}

/**
 * Fixed distinct id for exceptions captured outside a user session
 * (background workers, unauthenticated routes, process-level handlers).
 * Not a real person -- groups these in PostHog under one identity so
 * they're queryable, without inventing a fake per-error id.
 */
const SERVER_DISTINCT_ID = "server";

interface CaptureServerExceptionContext {
    /** Where the error was caught: "api" | "onRequestError" | "worker:sync" | ... */
    source: string;
    /** Known user, when available -- links the exception to a person. */
    distinctId?: string;
    [key: string]: unknown;
}

/**
 * Capture a server-side exception via PostHog's Error Tracking product
 * (proper stack-trace grouping, not a hand-rolled event). No-ops when
 * PostHog isn't configured for this deployment -- this is the single
 * place every server-side error-capture call site in the app should go
 * through, so self-host never depends on it and hosted never has to
 * remember to wire a new call site into two places.
 *
 * Fire-and-forget by design (never awaited by callers): call sites are
 * error paths that are already about to return/rethrow, and this must
 * never become the reason a request or worker tick hangs or fails.
 */
export function captureServerException(
    error: unknown,
    context: CaptureServerExceptionContext,
): void {
    const client = getPostHogClient();
    if (!client) return;
    const { distinctId, ...properties } = context;
    client
        .captureExceptionImmediate(
            error,
            distinctId ?? SERVER_DISTINCT_ID,
            properties,
        )
        .catch((captureError) => {
            console.error(
                "[posthog] failed to capture exception:",
                captureError,
            );
        });
}
