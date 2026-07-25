import { eq, and } from "drizzle-orm";
import { db, oauthTokensTable, type OauthTokenRow } from "@workspace/db";
import type { Request } from "express";
import { logger } from "./logger";

/**
 * Google OAuth for the two ingestion sources. One Google Cloud OAuth client
 * (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET) covers both; each
 * service is a separate consent + token row because the scopes differ:
 *  - google_photos → Photos Picker API (the only Photos access Google still
 *    allows since the Library API deprecation in 2025)
 *  - youtube       → YouTube Data API v3, read-only
 */

export type OauthService = "google_photos" | "youtube";

export const SERVICE_SCOPES: Record<OauthService, string> = {
  google_photos:
    "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
  youtube: "https://www.googleapis.com/auth/youtube.readonly",
};

export class OauthNotConnectedError extends Error {
  constructor(service: OauthService) {
    super(
      service === "google_photos"
        ? "Google Photos is not connected. Connect it from the upload dialog first."
        : "YouTube is not connected. Connect it from the upload dialog first.",
    );
    this.name = "OauthNotConnectedError";
  }
}

export function isGoogleOauthConfigured(): boolean {
  return Boolean(
    process.env["GOOGLE_OAUTH_CLIENT_ID"] &&
      process.env["GOOGLE_OAUTH_CLIENT_SECRET"],
  );
}

/** Public callback URL, derived from the incoming request (dev + prod safe). */
export function redirectUri(req: Request): string {
  const host = req.get("x-forwarded-host") ?? req.get("host") ?? "";
  const proto = req.get("x-forwarded-proto") ?? req.protocol ?? "https";
  return `${proto}://${host}/api/oauth/google/callback`;
}

export function buildAuthUrl(
  req: Request,
  service: OauthService,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: process.env["GOOGLE_OAUTH_CLIENT_ID"]!,
    redirect_uri: redirectUri(req),
    response_type: "code",
    scope: SERVICE_SCOPES[service],
    access_type: "offline",
    // Always re-prompt so Google re-issues a refresh token; without it a
    // second connect returns no refresh_token and the grant dies in an hour.
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

async function tokenRequest(
  params: Record<string, string>,
): Promise<TokenResponse> {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env["GOOGLE_OAUTH_CLIENT_ID"]!,
      client_secret: process.env["GOOGLE_OAUTH_CLIENT_SECRET"]!,
      ...params,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await resp.json()) as TokenResponse;
  if (!resp.ok || !data.access_token) {
    throw new Error(
      `Google token exchange failed: ${data.error ?? resp.status} ${data.error_description ?? ""}`.trim(),
    );
  }
  return data;
}

export async function exchangeCodeAndStore(
  req: Request,
  userId: number,
  service: OauthService,
  code: string,
): Promise<void> {
  const data = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(req),
  });
  const expiresAt = new Date(Date.now() + (data.expires_in ?? 3600) * 1000);
  const existing = await db
    .select()
    .from(oauthTokensTable)
    .where(
      and(
        eq(oauthTokensTable.userId, userId),
        eq(oauthTokensTable.provider, service),
      ),
    );
  if (existing.length > 0) {
    await db
      .update(oauthTokensTable)
      .set({
        accessToken: data.access_token!,
        // Keep the old refresh token if Google didn't send a new one.
        ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
        expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(oauthTokensTable.id, existing[0]!.id));
  } else {
    await db.insert(oauthTokensTable).values({
      userId,
      provider: service,
      accessToken: data.access_token!,
      refreshToken: data.refresh_token ?? null,
      expiresAt,
    });
  }
}

export async function getConnection(
  userId: number,
  service: OauthService,
): Promise<OauthTokenRow | null> {
  const rows = await db
    .select()
    .from(oauthTokensTable)
    .where(
      and(
        eq(oauthTokensTable.userId, userId),
        eq(oauthTokensTable.provider, service),
      ),
    );
  return rows[0] ?? null;
}

/**
 * Valid bearer token for the service, refreshing when within 2 minutes of
 * expiry. Throws OauthNotConnectedError when the user never connected or the
 * grant can no longer be refreshed (revoked).
 */
export async function getValidAccessToken(
  userId: number,
  service: OauthService,
): Promise<string> {
  const row = await getConnection(userId, service);
  if (!row) throw new OauthNotConnectedError(service);
  if (row.expiresAt.getTime() - Date.now() > 2 * 60 * 1000) {
    return row.accessToken;
  }
  if (!row.refreshToken) throw new OauthNotConnectedError(service);
  try {
    const data = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: row.refreshToken,
    });
    const expiresAt = new Date(Date.now() + (data.expires_in ?? 3600) * 1000);
    await db
      .update(oauthTokensTable)
      .set({ accessToken: data.access_token!, expiresAt, updatedAt: new Date() })
      .where(eq(oauthTokensTable.id, row.id));
    return data.access_token!;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), service },
      "OAuth refresh failed — treating connection as revoked",
    );
    await db.delete(oauthTokensTable).where(eq(oauthTokensTable.id, row.id));
    throw new OauthNotConnectedError(service);
  }
}
