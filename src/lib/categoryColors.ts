// THE category -> colour map. Every chart on the dashboard reads from here, so
// a category is the same colour in the donut, in the bars, in the detail list
// and in anything added later.
//
// The system is parent-hue / child-shade: a top-level category owns a hue, and
// its subcategories are lightness steps of that same hue - so the whole
// Food family reads as one warm colour and the whole Transport family as one
// blue, at a glance, without anybody memorising fifty swatches.
//
// Derivation (all of it computed, none of it eyeballed):
//   - Hue angles come from the data-viz skill's validated light categorical
//     palette, kept IN ITS SLOT ORDER, which is that palette's CVD-safety
//     mechanism rather than a cosmetic choice.
//   - Yellow is deliberately absent. It was the worst pair in the set (against
//     orange) and it is now the UI accent, so leaving it out of the charts
//     makes "yellow = something you can press" unambiguous.
//   - Each hue is stepped into five shades at even OKLCH lightness (0.76 ->
//     0.48, dL 0.07). Every ramp passes the ordinal checks: monotone
//     lightness, adjacent dL >= 0.06, lightest step >= 2:1 on white.
//   - With more top-level categories than hues, hues repeat - but a repeat is
//     given a different signature lightness, so two categories never share a
//     colour outright. See SIGNATURE_STEP.
//
// Known limit, stated rather than hidden: a pie shows whichever six categories
// happen to have spend, so the palette is used as an arbitrary subset. No
// multi-hue palette clears the all-pairs gates in that situation. Worst normal
// vision pair here is magenta vs orange (OKLab dE 12.1); red vs green are close
// under deuteranopia. That is why every slice is direct-labelled with its name
// and amount in the list, why slices carry a 2px gap, and why the bar chart has
// a legend - identity never rests on hue alone.
import type { CategoryNode } from "@/lib/dashboard";

/**
 * Ink that stays legible on top of a given fill - for the percentage printed on
 * a pie segment, where the segment's colour is whatever the category owns.
 * Computed from relative luminance rather than guessed per colour.
 */
export function readableInkOn(fill: string): string {
  const n = parseInt(fill.slice(1), 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const luminance =
    0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return luminance > 0.42 ? "#1c1917" : "#ffffff";
}

interface Hue {
  name: string;
  /** Five shades, lightest to darkest. */
  ramp: readonly string[];
  /** The washed-out step used for a comparison series. */
  muted: string;
}

const HUES: readonly Hue[] = [
  { name: "blue",    ramp: ["#7ab4ff", "#509cfd", "#3986e5", "#2170cd", "#005bb6"], muted: "#a5bbd8" },
  { name: "orange",  ramp: ["#ff8d64", "#f26e3b", "#d95821", "#bf4200", "#a03500"], muted: "#d5afa2" },
  { name: "aqua",    ramp: ["#48cc95", "#28b680", "#009f6c", "#00875b", "#00704b"], muted: "#9ec3b0" },
  { name: "magenta", ramp: ["#f789b2", "#df739c", "#c75d87", "#af4872", "#98335e"], muted: "#d4adb9" },
  { name: "green",   ramp: ["#64cd5d", "#4cb646", "#33a02e", "#128a0f", "#007300"], muted: "#a8c1a5" },
  { name: "violet",  ramp: ["#a7a6ff", "#908afe", "#7c74e6", "#685ece", "#5649b6"], muted: "#b4b6d7" },
  { name: "red",     ramp: ["#ff8a82", "#fb605c", "#e24847", "#c92e33", "#b0081d"], muted: "#d6aeaa" },
];

/**
 * Which shade a top-level category wears when it is a slice in its own right.
 * Indexed by [lap][hue]. The first lap splits the confusable pairs across
 * lightness - blue/violet, orange/red and aqua/green each sit at a different
 * step - which lifts the worst normal-vision pair from dE 5.3 to 12.1. The
 * second lap inverts that split, and the third takes the lightest step (those
 * categories are rare enough to spend most of their life inside "+N more").
 */
const SIGNATURE_STEP: readonly (readonly number[])[] = [
  [2, 2, 2, 2, 4, 4, 4],
  [4, 4, 4, 4, 2, 2, 2],
  [0, 0, 0, 0, 0, 0, 0],
];

/**
 * Hue assignment order for top-level categories. Explicit rather than derived,
 * because the pairing is semantic - transport is blue, food is warm, groceries
 * are green - and because it fixes which categories get a hue to themselves:
 * position i takes HUES[i % 7], so the first seven (the ones that actually
 * dominate a month) never share.
 */
const HUE_ORDER: readonly string[] = [
  // lap 1 - the categories that regularly carry a month
  "Transport & Fuel", "Food & Dining", "Travel", "Shopping",
  "Quick Commerce", "Gifts & Donations", "Person-to-Person",
  // lap 2
  "Utilities & Bills", "Indulgence", "Fitness", "Personal Care",
  "Kirana & Local Stores", "Subscriptions", "Household Help",
  // lap 3
  "Rent", "Cash Withdrawal", "Insurance", "Entertainment",
  "Healthcare", "Education", "Other",
];

/** Absence of a category, not a small one - so, deliberately not a hue. */
export const UNCATEGORISED_COLOR = "#9a938b";
/** The folded tail: a drawing device, not a category. */
export const ROLLUP_COLOR = "#bdb6ab";
/**
 * "All spend" is every hue at once, so it gets none of them - a deep amber
 * instead. Deliberately NOT the yellow accent itself: yellow is 1.5:1 on white,
 * which is fine behind dark text on a pill and useless as a chart mark.
 */
export const ALL_SPEND_COLOR = "#8a5f00";

/**
 * The comparison series, for every scope. A single achromatic warm grey rather
 * than a wash of the current series' hue: two shades of one colour are easy to
 * mistake for each other at a glance, and having no chroma at all means this
 * can never be read as one of the category hues either. "Grey is the past"
 * then stays true whatever the user has drilled into.
 */
export const COMPARISON_COLOR = "#aca396";

export interface CategoryPalette {
  /** The colour a category wears as a slice or a bar. */
  color: (categoryId: number) => string;
  /** The comparison series colour. One neutral for every scope - see COMPARISON_COLOR. */
  muted: () => string;
  /** The solid step of a category's hue, for a current series. */
  solid: (categoryId: number | null) => string;
  /** Shades of one category's hue, for slicing something that isn't a category (payees). */
  shades: (categoryId: number | null, count: number) => string[];
}

/** Spread `count` picks across a five-step ramp, always using both ends. */
function spread(ramp: readonly string[], count: number): string[] {
  if (count <= 1) return [ramp[2]];
  return Array.from({ length: count }, (_, i) =>
    ramp[Math.round((i / (count - 1)) * (ramp.length - 1))]
  );
}

export function buildCategoryPalette(categories: CategoryNode[]): CategoryPalette {
  const byId = new Map(categories.map((c) => [c.id, c]));

  const topOf = (id: number): number => {
    let current = id;
    for (let guard = 0; guard < 16; guard++) {
      const parent = byId.get(current)?.parentId;
      if (parent == null) return current;
      current = parent;
    }
    return current;
  };

  // Top-level categories in HUE_ORDER first, then anything unlisted by id, so
  // adding a category can never reshuffle the colours of the existing ones.
  const tops = categories.filter((c) => c.parentId == null);
  const ranked = [...tops].sort((a, b) => {
    const ai = HUE_ORDER.indexOf(a.name);
    const bi = HUE_ORDER.indexOf(b.name);
    if (ai !== bi) return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
    return a.id - b.id;
  });

  const hueOf = new Map<number, Hue>();
  const signatureOf = new Map<number, string>();
  ranked.forEach((cat, i) => {
    const hue = HUES[i % HUES.length];
    const lap = Math.min(Math.floor(i / HUES.length), SIGNATURE_STEP.length - 1);
    hueOf.set(cat.id, hue);
    signatureOf.set(cat.id, hue.ramp[SIGNATURE_STEP[lap][i % HUES.length]]);
  });

  // A subcategory takes a step of its parent's ramp, positioned by its rank
  // among its siblings by id - stable across renames and across re-sorting the
  // chart, so a subcategory keeps its colour as the data moves.
  const childShade = new Map<number, string>();
  for (const parent of tops) {
    const hue = hueOf.get(parent.id);
    if (!hue) continue;
    const children = categories.filter((c) => c.parentId === parent.id).sort((a, b) => a.id - b.id);
    const shades = spread(hue.ramp, children.length);
    children.forEach((child, i) => childShade.set(child.id, shades[i]));
  }

  const rampOf = (categoryId: number | null): readonly string[] =>
    (categoryId == null ? undefined : hueOf.get(topOf(categoryId))?.ramp) ?? HUES[0].ramp;

  return {
    color: (categoryId) =>
      signatureOf.get(categoryId) ?? childShade.get(categoryId) ?? UNCATEGORISED_COLOR,
    solid: (categoryId) =>
      categoryId == null ? ALL_SPEND_COLOR : rampOf(categoryId)[2],
    muted: () => COMPARISON_COLOR,
    shades: (categoryId, count) => spread(rampOf(categoryId), count),
  };
}
