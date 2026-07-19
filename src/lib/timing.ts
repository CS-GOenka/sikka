// Basic request-timing diagnostic. `cold` is a best-effort heuristic: a
// module-level Set survives across warm invocations of the same serverless
// function instance but resets when a fresh instance is provisioned, which
// is what we actually want to distinguish for a cold-start diagnosis.
const warmLabels = new Set<string>();

export function startTiming(label: string) {
  const start = performance.now();
  const cold = !warmLabels.has(label);
  warmLabels.add(label);
  return function endTiming() {
    const ms = Math.round(performance.now() - start);
    console.log(`[timing] ${label} ${ms}ms cold=${cold}`);
  };
}
