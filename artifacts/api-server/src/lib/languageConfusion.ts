/**
 * Language-confusion clusters for South-Asian languages that are often
 * mis-detected by Whisper-style transcription models. Stored as a static
 * lookup table keyed by language code, pointing to the cluster IDs the
 * language belongs to. A language can appear in multiple clusters.
 */

export const LANGUAGE_CONFUSION_CLUSTERS = {
  "telugu-kannada": ["te", "kn"],
  "tamil-malayalam": ["ta", "ml"],
  "hindi-urdu": ["hi", "ur"],
  "bengali-assamese": ["bn", "as"],
  "bengali-odia": ["bn", "or"],
  "hindi-belt": ["hi", "raj", "pa"],
  "gujarati-marathi": ["gu", "mr"],
  "sindhi-urdu": ["sd", "ur"],
} as const;

export type ClusterId = keyof typeof LANGUAGE_CONFUSION_CLUSTERS;
export type LanguageCode =
  | (typeof LANGUAGE_CONFUSION_CLUSTERS)[ClusterId][number]
  | string;

/** Mapping from a language code to every cluster it participates in. */
export const LANGUAGE_TO_CLUSTERS: Readonly<Record<string, readonly string[]>> =
  (() => {
    const map: Record<string, string[]> = {};
    for (const [clusterId, codes] of Object.entries(LANGUAGE_CONFUSION_CLUSTERS)) {
      for (const code of codes) {
        (map[code] ??= []).push(clusterId);
      }
    }
    return map;
  })();

/** Clusters that contain a given language code. */
export function clustersForLanguage(code: string): readonly string[] {
  return LANGUAGE_TO_CLUSTERS[code] ?? [];
}

/**
 * Human-readable display name for a language code. Only covers the cluster
 * languages; unknown codes fall back to the code itself.
 */
export const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  te: "Telugu",
  kn: "Kannada",
  ta: "Tamil",
  ml: "Malayalam",
  hi: "Hindi",
  ur: "Urdu",
  bn: "Bengali",
  as: "Assamese",
  or: "Odia",
  raj: "Rajasthani",
  pa: "Punjabi",
  gu: "Gujarati",
  mr: "Marathi",
  sd: "Sindhi",
};

export function displayName(code: string): string {
  return LANGUAGE_DISPLAY_NAMES[code] ?? code;
}

/**
 * For a detected language and a user's saved language profile, return the
 * first cluster where a confusion risk exists. A risk exists when:
 *   1. The detected language is part of a cluster, AND
 *   2. The user's profile contains at least one other member of that cluster.
 *
 * Returns the matching cluster and the list of candidate languages (always
 * includes the detected language plus the user's other cluster members).
 */
export function findLanguageConfusion(
  detected: string,
  userProfile: string[],
): {
  clusterId: ClusterId;
  detected: string;
  candidates: string[];
} | null {
  const clusters = clustersForLanguage(detected);
  if (clusters.length === 0) return null;
  const profileSet = new Set(userProfile.map((c) => c.toLowerCase()));
  if (profileSet.has(detected.toLowerCase())) {
    profileSet.delete(detected.toLowerCase());
  }
  for (const clusterId of clusters) {
    const members = LANGUAGE_CONFUSION_CLUSTERS[clusterId as ClusterId];
    const overlaps = members.filter((m) => profileSet.has(m.toLowerCase()));
    if (overlaps.length > 0) {
      const candidates = Array.from(
        new Set([detected, ...overlaps, ...members]),
      ).filter((c) => profileSet.has(c.toLowerCase()) || c.toLowerCase() === detected.toLowerCase());
      return {
        clusterId: clusterId as ClusterId,
        detected,
        candidates,
      };
    }
  }
  return null;
}

/**
 * Very lightweight script-based detector for the Indic/Abed scripts that appear
 * in the confusion clusters. Returns the single most likely language code, or
 * null if no cluster script is found. This is used only as a fallback when the
 * transcription backend does not expose the language it auto-detected.
 */
const SCRIPT_TO_LANGUAGES: Record<string, string[]> = {
  Devanagari: ["hi"], // Hindi, Rajasthani, Marathi all use Devanagari; default to Hindi as the most common.
  Bengali: ["bn"], // Bengali and Assamese share the Bengali script; default to Bengali.
  Oriya: ["or"],
  Telugu: ["te"],
  Kannada: ["kn"],
  Tamil: ["ta"],
  Malayalam: ["ml"],
  Gujarati: ["gu"],
  Gurmukhi: ["pa"], // Punjabi (Gurmukhi)
  Arabic: ["ur"], // Urdu and Sindhi both use Arabic script; default to Urdu.
};

const SCRIPT_RANGES: Array<{ name: string; regex: RegExp }> = [
  { name: "Devanagari", regex: /[\u0900-\u097F]/ },
  { name: "Bengali", regex: /[\u0980-\u09FF]/ },
  { name: "Gurmukhi", regex: /[\u0A00-\u0A7F]/ },
  { name: "Gujarati", regex: /[\u0A80-\u0AFF]/ },
  { name: "Oriya", regex: /[\u0B00-\u0B7F]/ },
  { name: "Tamil", regex: /[\u0B80-\u0BFF]/ },
  { name: "Telugu", regex: /[\u0C00-\u0C7F]/ },
  { name: "Kannada", regex: /[\u0C80-\u0CFF]/ },
  { name: "Malayalam", regex: /[\u0D00-\u0D7F]/ },
  { name: "Arabic", regex: /[\u0600-\u06FF]/ },
];

export function detectTranscriptLanguage(text: string): string | null {
  let bestName: string | null = null;
  let bestCount = 0;
  for (const { name, regex } of SCRIPT_RANGES) {
    const matches = text.match(regex);
    const count = matches ? matches.length : 0;
    if (count > bestCount) {
      bestCount = count;
      bestName = name;
    }
  }
  if (!bestName || bestCount < 3) return null;
  const candidates = SCRIPT_TO_LANGUAGES[bestName];
  return candidates?.[0] ?? null;
}
