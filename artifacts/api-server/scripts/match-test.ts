/**
 * Regression test for the privacy-scan matcher: negated enumerations must
 * never flag, genuine positive mentions must. Run after any matcher change.
 * Usage: node dist/match-test.mjs
 */
import { evaluateScenes } from "../src/lib/ingestion";

type Case = {
  name: string;
  description: string;
  expect: string[]; // expected matched reasons (baseline labels only)
};

const cases: Case[] = [
  {
    name: "negated enumeration (do not see)",
    description:
      "The scene appears to show an indoor room with shelves. I do not see any readable screens, personal documents, financial information, hospitals, or license plates.",
    expect: [],
  },
  {
    name: "negated enumeration (leading No)",
    description:
      "A classroom lecture is shown. No computer, phone, laptop screen, personal documents, financial information, undressed people, medical setting, or readable license plate.",
    expect: [],
  },
  {
    name: "neither/nor enumeration",
    description:
      "Neither a computer, phone, or laptop screen with readable content nor personal documents are visible in this scene.",
    expect: [],
  },
  {
    name: "plain positive mention",
    description: "A passport lies open on the table next to a coffee cup.",
    expect: ["Baseline: Personal documents or IDs"],
  },
  {
    name: "adversative resets negation",
    description: "No clutter, but a passport lies open on the table.",
    expect: ["Baseline: Personal documents or IDs"],
  },
  {
    name: "positive screen mention",
    description: "A laptop screen displaying an email inbox is clearly readable.",
    expect: ["Baseline: Visible screen content"],
  },
  {
    name: "hedged mention (not readable)",
    description: "A car is parked outside; the license plate is not readable.",
    expect: [],
  },
  {
    name: "two positives in one scene",
    description:
      "The desk shows a credit card next to a passport under bright light.",
    expect: [
      "Baseline: Financial information",
      "Baseline: Personal documents or IDs",
    ],
  },
  {
    name: "positive sentence after negative sentence",
    description:
      "No people are visible in the room. A hospital bed and medication bottles stand in the corner.",
    expect: ["Baseline: Medical context"],
  },
  {
    name: "trailing negation after the noun",
    description: "Personal documents are not visible on the desk.",
    expect: [],
  },
  {
    name: "adversative after positive keeps the match",
    description: "A passport lies open on the table but the light is not great.",
    expect: ["Baseline: Personal documents or IDs"],
  },
  {
    name: "semicolon-separated negated enumeration",
    description:
      "The scene shows a room. I do not see a computer, phone, or laptop screen with readable content; personal documents; financial information; or readable license plates.",
    expect: [],
  },
  {
    name: "distributive negation across semicolons",
    description:
      "It does not show a computer, phone, or laptop screen with readable content; no personal documents; no financial information; no hospital setting; no readable license plate.",
    expect: [],
  },
  {
    // Accepted tradeoff: a genuinely positive clause after a semicolon in a
    // negated sentence is suppressed. Positive mentions in this corpus are
    // written as their own sentences, which still flag (previous case).
    name: "positive clause after semicolon is suppressed by design",
    description: "No people are visible; a hospital bed stands in the corner.",
    expect: [],
  },
  {
    name: "curly-apostrophe don’t enumeration",
    description:
      "A woman stands near a turquoise wall. I don’t see any readable screens, personal documents, financial information, medical setting/medication, nudity, or a readable license plate.",
    expect: [],
  },
  {
    name: "positive sentence after negated enumeration in same scene",
    description:
      "Neither financial information; a medical setting or visible medication; nor a readable license plate are visible. The adult appears to be undressed or in a private moment.",
    expect: ["Baseline: Possible private moment"],
  },
];

let failures = 0;
for (const c of cases) {
  const matched = evaluateScenes(
    [{ start: 0, description: c.description }],
    null,
  );
  const got = [...matched.keys()].sort();
  const want = [...c.expect].sort();
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) failures += 1;
  console.log(
    `${pass ? "PASS" : "FAIL"} — ${c.name}${pass ? "" : ` | got: ${JSON.stringify(got)} want: ${JSON.stringify(want)}`}`,
  );
}

if (failures > 0) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log("all matcher cases pass");
