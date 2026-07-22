import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { acquirePlaudConnectLock } from "@/db/queries/plaud-locks";
import { plaudConnections, plaudDevices } from "@/db/schema";
import { encrypt } from "@/lib/encryption";
import {
    captureServerEvent,
    captureServerException,
} from "@/lib/posthog-server";
import type { PlaudDeviceListResponse } from "@/types/plaud";
import { PlaudClient } from "./client";
import { listPlaudWorkspaces, pickPersonalWorkspaceId } from "./workspace";

export interface PersistPlaudConnectionInput {
    userId: string;
    accessToken: string;
    apiBase: string;
    plaudEmail: string | null;
    /** How this connection was established. Drives the `plaud_connected` event's `method` property. */
    method: "otp" | "paste" | "connector" | "unknown";
}

export interface PersistPlaudConnectionResult {
    devices: PlaudDeviceListResponse["data_devices"];
    workspaceId: string | null;
}

/** Validate a Plaud user token and persist the connection. Idempotent. */
export async function persistPlaudConnection({
    userId,
    accessToken,
    apiBase,
    plaudEmail,
    method,
}: PersistPlaudConnectionInput): Promise<PersistPlaudConnectionResult> {
    let resolvedWorkspaceId: string | null = null;
    try {
        const list = await listPlaudWorkspaces(accessToken, apiBase);
        resolvedWorkspaceId = pickPersonalWorkspaceId(list);
    } catch (err) {
        console.warn(
            "[plaud/persist] workspace discovery failed:",
            err instanceof Error ? err.message : err,
        );
        captureServerException(err, {
            source: "plaud",
            distinctId: userId,
            reason: "workspace_discovery_failed",
        });
    }

    const client = new PlaudClient(accessToken, apiBase, resolvedWorkspaceId);
    let deviceList: PlaudDeviceListResponse;
    try {
        deviceList = await client.listDevices();
    } catch (err) {
        console.warn(
            "[plaud/persist] device list validation failed:",
            err instanceof Error ? err.message : err,
        );
        captureServerException(err, {
            source: "plaud",
            distinctId: userId,
            reason: "device_list_failed",
        });
        throw err;
    }

    const encryptedAccessToken = encrypt(accessToken);

    await db.transaction(async (tx) => {
        await acquirePlaudConnectLock(tx, userId);

        const [existingConnection] = await tx
            .select()
            .from(plaudConnections)
            .where(eq(plaudConnections.userId, userId))
            .limit(1);

        if (existingConnection) {
            await tx
                .update(plaudConnections)
                .set({
                    bearerToken: encryptedAccessToken,
                    apiBase,
                    plaudEmail,
                    workspaceId: resolvedWorkspaceId,
                    // Reconnecting with a fresh token clears any prior
                    // "needs reconnect" state so the banner disappears.
                    invalidatedAt: null,
                    updatedAt: new Date(),
                })
                .where(
                    and(
                        eq(plaudConnections.id, existingConnection.id),
                        eq(plaudConnections.userId, userId),
                    ),
                );
        } else {
            await tx.insert(plaudConnections).values({
                userId,
                bearerToken: encryptedAccessToken,
                apiBase,
                plaudEmail,
                workspaceId: resolvedWorkspaceId,
            });
        }

        for (const device of deviceList.data_devices) {
            const [existingDevice] = await tx
                .select()
                .from(plaudDevices)
                .where(
                    and(
                        eq(plaudDevices.userId, userId),
                        eq(plaudDevices.serialNumber, device.sn),
                    ),
                )
                .limit(1);

            if (existingDevice) {
                await tx
                    .update(plaudDevices)
                    .set({
                        name: device.name,
                        model: device.model,
                        versionNumber: device.version_number,
                        updatedAt: new Date(),
                    })
                    .where(eq(plaudDevices.id, existingDevice.id));
            } else {
                await tx.insert(plaudDevices).values({
                    userId,
                    serialNumber: device.sn,
                    name: device.name,
                    model: device.model,
                    versionNumber: device.version_number,
                });
            }
        }
    });

    await captureServerEvent({
        distinctId: userId,
        event: "plaud_connected",
        properties: { method, device_count: deviceList.data_devices.length },
    });

    return {
        devices: deviceList.data_devices,
        workspaceId: resolvedWorkspaceId,
    };
}
