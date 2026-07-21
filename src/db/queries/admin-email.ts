import { count, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    type CampaignKind,
    normalizeCampaignKind,
} from "@/db/queries/email-campaigns";
import {
    emailCampaigns,
    emailDeliveries,
    emailSuppressions,
    newsletterSubscriptions,
} from "@/db/schema";

export interface CampaignOverviewRow {
    id: string;
    slug: string;
    subject: string;
    kind: CampaignKind;
    createdAt: Date;
    attempted: number;
    sent: number;
    failed: number;
    skipped: number;
    pending: number;
    /**
     * Deliveries whose `status` didn't match any of the known buckets above.
     * `emailDeliveries.status` is a bare `varchar`, not a DB enum, so a
     * future status string (or manual DB edit) can silently fall through
     * the `sent`/`failed`/`skipped_*`/`pending` filters. Surfacing the
     * remainder here keeps `sent + failed + skipped + pending + other`
     * always equal to `attempted` instead of quietly under-counting.
     */
    other: number;
}

/**
 * Campaigns joined with delivery status counts, newest first. Statuses are
 * pivoted with `filter` aggregates rather than a per-campaign N+1 query.
 */
export async function listCampaignsOverview(
    limit = 50,
): Promise<CampaignOverviewRow[]> {
    const rows = await db
        .select({
            id: emailCampaigns.id,
            slug: emailCampaigns.slug,
            subject: emailCampaigns.subject,
            kind: emailCampaigns.kind,
            createdAt: emailCampaigns.createdAt,
            attempted: count(emailDeliveries.id),
            sent: sql<number>`count(*) filter (where ${emailDeliveries.status} = 'sent')::int`,
            failed: sql<number>`count(*) filter (where ${emailDeliveries.status} = 'failed')::int`,
            skipped: sql<number>`count(*) filter (where ${emailDeliveries.status} like 'skipped_%')::int`,
            pending: sql<number>`count(*) filter (where ${emailDeliveries.status} = 'pending')::int`,
        })
        .from(emailCampaigns)
        .leftJoin(
            emailDeliveries,
            eq(emailDeliveries.campaignId, emailCampaigns.id),
        )
        .groupBy(
            emailCampaigns.id,
            emailCampaigns.slug,
            emailCampaigns.subject,
            emailCampaigns.kind,
            emailCampaigns.createdAt,
        )
        .orderBy(desc(emailCampaigns.createdAt))
        .limit(limit);

    return rows.map((r) => {
        const attempted = Number(r.attempted);
        const sent = Number(r.sent);
        const failed = Number(r.failed);
        const skipped = Number(r.skipped);
        const pending = Number(r.pending);
        return {
            id: r.id,
            slug: r.slug,
            subject: r.subject,
            kind: normalizeCampaignKind(r.kind, r.slug),
            createdAt: r.createdAt,
            attempted,
            sent,
            failed,
            skipped,
            pending,
            other: Math.max(0, attempted - sent - failed - skipped - pending),
        };
    });
}

/** Total campaign count, uncapped -- pairs with `listCampaignsOverview`'s limit. */
export async function countCampaigns(): Promise<number> {
    const [row] = await db.select({ n: count() }).from(emailCampaigns);
    return Number(row?.n ?? 0);
}

export interface SuppressionRow {
    email: string;
    reason: string;
    note: string | null;
    createdAt: Date;
}

/** Suppression counts grouped by reason (unsubscribe/bounce/complaint/manual). */
export async function suppressionCountsByReason(): Promise<
    { reason: string; n: number }[]
> {
    const rows = await db
        .select({
            reason: emailSuppressions.reason,
            n: count(),
        })
        .from(emailSuppressions)
        .groupBy(emailSuppressions.reason)
        .orderBy(desc(count()));
    return rows.map((r) => ({ reason: r.reason, n: Number(r.n) }));
}

/** Most recently suppressed addresses, newest first. */
export async function recentSuppressions(
    limit = 50,
): Promise<SuppressionRow[]> {
    return db
        .select({
            email: emailSuppressions.email,
            reason: emailSuppressions.reason,
            note: emailSuppressions.note,
            createdAt: emailSuppressions.createdAt,
        })
        .from(emailSuppressions)
        .orderBy(desc(emailSuppressions.createdAt))
        .limit(limit);
}

export interface NewsletterStats {
    total: number;
    confirmed: number;
    unsubscribed: number;
}

/** Newsletter subscription funnel: total signups, confirmed, unsubscribed. */
export async function newsletterStats(): Promise<NewsletterStats> {
    const [row] = await db
        .select({
            total: count(),
            confirmed: sql<number>`count(*) filter (where ${newsletterSubscriptions.confirmedAt} is not null)::int`,
            unsubscribed: sql<number>`count(*) filter (where ${newsletterSubscriptions.unsubscribedAt} is not null)::int`,
        })
        .from(newsletterSubscriptions);
    return {
        total: Number(row?.total ?? 0),
        confirmed: Number(row?.confirmed ?? 0),
        unsubscribed: Number(row?.unsubscribed ?? 0),
    };
}
