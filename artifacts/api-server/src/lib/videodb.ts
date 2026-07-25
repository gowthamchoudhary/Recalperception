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
 * Bounds a VideoDB call. The SDK has no request timeout, so a wedged
 * connection otherwise hangs forever (observed: indexScenes normally returns
 * in ~1s, but stuck requests sat for 20+ minutes). A timeout surfaces as a
 * normal error instead of leaving work in limbo.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`${label} timed out after ${Math.round(ms / 1000)}s`),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  return withTimeout(conn.getCollection(), 60_000, "VideoDB collection fetch");
}
