/** Human-readable names for the language codes Recall supports. */
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
  en: "English",
};

export function languageDisplayName(code: string): string {
  return LANGUAGE_DISPLAY_NAMES[code.toLowerCase()] ?? code;
}

/** All languages that participate in the confusion clusters. */
export const CLUSTER_LANGUAGES = [
  "te", "kn", "ta", "ml", "hi", "ur", "bn", "as", "or", "raj", "pa", "gu", "mr", "sd",
];
