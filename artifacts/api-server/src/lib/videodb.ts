import { connect, type Collection } from "videodb";

export class VideoDBNotConfiguredError extends Error {
  constructor() {
    super(
      "VideoDB is not configured. Add the VIDEODB_API_KEY secret to enable real video ingestion and search.",
    );
    this.name = "VideoDBNotConfiguredError";
  }
}

export function isVideoDBConfigured(): boolean {
  return Boolean(process.env["VIDEODB_API_KEY"]);
}

/** True when a VideoDB error means the asset is already gone. */
export function isVideoDBNotFoundError(err: unknown): boolean {
  return (
    err instanceof Error && /not found|404|does not exist/i.test(err.message)
  );
}

/**
 * Returns the default VideoDB collection.
 * Never cache the returned object across requests: connections are cheap and
 * the API key may be rotated at runtime.
 */
export async function getVideoDBCollection(): Promise<Collection> {
  const apiKey = process.env["VIDEODB_API_KEY"];
  if (!apiKey) {
    throw new VideoDBNotConfiguredError();
  }
  const conn = connect(apiKey);
  return conn.getCollection();
}
