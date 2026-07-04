import assert from "node:assert/strict";
import { bestDraftFallback, hasPlanSections, withDegradedWarning } from "./plan";

const relayNarrationFixture = `> **WARNING (Fuse):** finalize failed.

I need to inspect the repository first:

\`\`\`sh
ls -la
\`\`\`
`;

const validPlan = `## Goal
Ship the requested change.

## Affected files
- lib/plan.ts (edit)

## Implementation steps
1. Update the pipeline.

## Risks & mitigations
- Risk: stale prompt contracts. Mitigation: keep helpers covered.

## Testing
- Run npx tsc --noEmit.
`;

const preambleThenPlan = `I need to inspect the repository first.

${validPlan}`;

assert.equal(hasPlanSections(validPlan), true);
assert.equal(hasPlanSections(relayNarrationFixture), false);
assert.equal(hasPlanSections(preambleThenPlan), false);
assert.equal(bestDraftFallback(relayNarrationFixture, validPlan), validPlan);

const degradedRelayOutput = withDegradedWarning("finalize", bestDraftFallback(relayNarrationFixture, validPlan));
assert.match(degradedRelayOutput, /^> \*\*WARNING \(Fuse\):\*\* the finalize stage failed/);
assert.match(degradedRelayOutput, /## Goal/);
assert.doesNotMatch(degradedRelayOutput, /ls -la/);
