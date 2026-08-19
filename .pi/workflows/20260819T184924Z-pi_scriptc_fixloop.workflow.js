// Pi workflow review artifact.
// TRUST: this trusted JavaScript runs with full host privileges, not inside a sandbox.
// globalThis, Function, dynamic import(), and host APIs may be reachable.
export const meta = {
  name: "pi_scriptc_fixloop",
  description: "Research, propose, apply and verify fixes for the remaining scriptc errors until pi compiles to a native binary",
  whenToUse: "Driving the pi x scriptc port to zero diagnostics without losing pi features",
  phases: [
    { title: "Measure" },
    { title: "Research" },
    { title: "Implement" },
    { title: "Verify" },
    { title: "Report" },
  ],
};

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const MAX_ROUNDS = 12;
const CLUSTERS_PER_ROUND = 3;
const MAX_DRY_STREAK = 3;

const ROOT = "/home/gustavo/src/pi";
const READ_ONLY = { mode: "worktree", dirty: "ignore", merge: "none" };

// ---------------------------------------------------------------------------
// Shared background. Subagents start with an EMPTY conversation, so every prompt
// below inlines this. It encodes hard-won rules; agents that ignore it will
// rediscover dead ends that already cost hours.
// ---------------------------------------------------------------------------
const CONTEXT = `# Project

Goal: compile the pi coding agent (TypeScript monorepo at ${ROOT}, branch \`scriptc-port\`)
into a native binary with scriptc 0.0.33 (a restricted TypeScript-to-native compiler).

## Absolute rules

1. NEVER post anything to GitHub. No issues, no comments, no PRs. Local work only.
2. NEVER remove or degrade a pi feature to make the compiler happy. Deleting a code
   path, stubbing a function to a no-op, weakening a type to silence a check, or
   dropping a command/flag/UI behaviour all count as failure. If the only fix you can
   find loses a feature, report that honestly instead of applying it.
3. pi's own build must stay green. \`npm run build\` must exit 0 and
   \`node dist/cli.js --version\` must print 0.84.2 after any change.
4. Commit with \`git commit --no-verify\` (the husky hook fails on pre-existing tsgo
   errors in packages/ai that are also broken on main).

## How the build works

Staging transform + compile (never edit \`.scriptc-stage/\` by hand; it is regenerated):

\`\`\`bash
cd ${ROOT}
node scripts/scriptc-stage.mjs --island @earendil-works/pi-ai
export PATH=$HOME/.local/bin:$PATH
SCRIPTC_CC=zigcc timeout 3600 scriptc build .scriptc-stage/packages/coding-agent/src/cli.ts \\
  --dynamic -o /tmp/pi-native
\`\`\`

The build can take many minutes. Always wrap it in \`timeout 3600\` and be patient.

\`scripts/scriptc-stage.mjs\` (plus \`scriptc-stage-text.mjs\` and \`scriptc-stage-lazy.mjs\`)
copy pi's sources into \`.scriptc-stage/\` and rewrite them. Prefer fixing things in the
staging transform when the change is scriptc-specific plumbing; edit pi sources under
\`packages/\` when the change is a genuine improvement or is semantically neutral for pi.

## MEASUREMENT TRAP — read this twice

scriptc halts at typecheck (\`SC0001\`) errors BEFORE it runs lowering. So if a change
introduces a type error, the reported error count can DROP sharply while things got
worse. A lower number is only real when there are zero SC0001 errors. Always report
the SC0001 count separately.

## Compiler rules already established by experiment (do not re-litigate)

- An island binding may be CALLED from a named program function, but cannot be captured
  in an inline closure or stored as a value (SC1090 "binding form with no lowering"):
    BAD:  const o = { segment: (s) => segmentGraphemes(s) };
    GOOD: function segNamed(s) { return segmentGraphemes(s); }
          const o = { segment: segNamed };
- A package must resolve AS A PACKAGE (in node_modules) to be islanded. Vendoring it by
  relative path silently turns it into program code.
- Values cross the static/island boundary BY COPY, but a record containing a Map cannot
  cross at all, so an island round-trip is not a usable deep clone.
- Vendoring \`marked\` does NOT fix \`extends Tokenizer\`: type resolution still goes
  through marked.d.ts, so the base class stays ambient and \`extends\` stays SC1090.
  This was tried and reverted. Do not retry it unchanged.
- \`--npm-static\` refuses pi-tui, pi-ai and marked ("inferred export surface breaks N
  import sites"). That is a compiler-side wall, not fixable from pi.
- The island shims 33 builtins (see SHIMMED_BUILTINS in the installed scriptc at
  \`dist/frontend/npm.js\`) but NOT \`vm\` and NOT \`Intl\`.
- \`new Function\` works inside island (package) code.
- scriptc does not adopt tsconfig \`paths\`.

## Useful references

- scriptc source checkout: /home/gustavo/src/scriptc  (read it to find exact lowering
  rules; \`dist/frontend/*.js\` in the installed package is also readable)
- status write-up: /home/gustavo/src/scriptc-pi-status.md
- proof-of-concept binaries: /tmp/evaltest/
- You may modify the local scriptc checkout if a compiler change is genuinely the only
  faithful fix, but treat that as a last resort and say so loudly.

## Methodology that has worked

Write a minimal probe in /tmp (10-20 lines), compile it with scriptc, and observe the
exact diagnostic BEFORE touching pi. Guessing at scriptc's rules wastes far more time
than probing them.`;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const MEASURE = {
  type: "object",
  required: ["errorCount", "typecheckErrorCount", "buildSucceeded", "clusters"],
  properties: {
    errorCount: { type: "number" },
    typecheckErrorCount: { type: "number" },
    buildSucceeded: { type: "boolean" },
    binaryRuns: { type: "boolean" },
    logPath: { type: "string" },
    notes: { type: "string" },
    clusters: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "rootCause", "files", "errorCount", "sampleDiagnostics"],
        properties: {
          id: { type: "string" },
          rootCause: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          errorCodes: { type: "array", items: { type: "string" } },
          errorCount: { type: "number" },
          sampleDiagnostics: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const PROPOSAL = {
  type: "object",
  required: ["clusterId", "approach", "confidence", "losesFeature", "filesToEdit", "steps"],
  properties: {
    clusterId: { type: "string" },
    approach: { type: "string" },
    rationale: { type: "string" },
    probeEvidence: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    losesFeature: { type: "boolean" },
    featureRisk: { type: "string" },
    filesToEdit: { type: "array", items: { type: "string" } },
    steps: { type: "array", items: { type: "string" } },
    rejectedAlternatives: { type: "array", items: { type: "string" } },
  },
};

const IMPLEMENTED = {
  type: "object",
  required: ["applied", "summary", "filesChanged"],
  properties: {
    applied: { type: "boolean" },
    summary: { type: "string" },
    filesChanged: { type: "array", items: { type: "string" } },
    deviation: { type: "string" },
    piBuildGreen: { type: "boolean" },
  },
};

const REVIEW = {
  type: "object",
  required: ["featureLoss", "verdict", "reasons"],
  properties: {
    featureLoss: { type: "boolean" },
    verdict: { type: "string", enum: ["accept", "revert"] },
    reasons: { type: "array", items: { type: "string" } },
    suspiciousHunks: { type: "array", items: { type: "string" } },
  },
};

const SETTLE = {
  type: "object",
  required: ["action", "note"],
  properties: {
    action: { type: "string", enum: ["committed", "reverted", "nothing"] },
    note: { type: "string" },
  },
};

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------
const measurePrompt = (round) => `${CONTEXT}

# Your task (round ${round}): measure the current state

1. cd ${ROOT} and confirm you are on branch \`scriptc-port\` with a clean tree
   (\`git status --short\`). Report any unexpected dirt in \`notes\` but do not revert it.
2. Regenerate the stage and run the build exactly as documented above, writing the log
   to /tmp/fixloop-r${round}.txt.
3. Count diagnostics: \`grep -c 'error SC' /tmp/fixloop-r${round}.txt\` and separately
   \`grep -c 'error SC0001' /tmp/fixloop-r${round}.txt\`. Remember the measurement trap:
   report the SC0001 count in \`typecheckErrorCount\` even if it is zero.
4. If zero diagnostics: check whether /tmp/pi-native exists, set \`buildSucceeded\`, then
   try \`/tmp/pi-native --version\` and set \`binaryRuns\` accordingly.
5. Group every remaining diagnostic into clusters BY SHARED ROOT CAUSE (not by error
   code and not one-per-line). Two diagnostics belong together when one fix would
   plausibly resolve both. Give each cluster a stable kebab-case \`id\`, the exact list
   of source files involved (paths under packages/, not .scriptc-stage/), and up to 4
   verbatim sample diagnostics.

Return the structured result. Do not fix anything in this task.`;

const researchPrompt = (cluster, round, priorFailures) => `${CONTEXT}

# Your task (round ${round}): research ONE cluster and propose a fix

You are researching this cluster only. Do NOT edit any file in ${ROOT}; you are in a
read-only worktree. Your output is a proposal that a separate implementer will apply.

Cluster id: ${cluster.id}
Suspected root cause: ${cluster.rootCause}
Files involved:
${(cluster.files ?? []).map((f) => `  - ${f}`).join("\n")}
Diagnostics (${cluster.errorCount} total, samples):
${(cluster.sampleDiagnostics ?? []).map((d) => `  ${d}`).join("\n")}
${priorFailures.length ? `\nApproaches already TRIED AND REJECTED for this cluster in earlier rounds — do not repeat them:\n${priorFailures.map((f) => `  - ${f}`).join("\n")}` : ""}

Method:
1. Read the actual source of every file involved, and read the relevant scriptc lowering
   code in /home/gustavo/src/scriptc (or the installed dist) to learn the EXACT rule
   that is being violated. Quote the rule.
2. Write a minimal probe under /tmp/fixloop-probe-${cluster.id}/ that reproduces the
   diagnostic in 10-20 lines, then vary it until it compiles. Compile probes with:
   \`export PATH=$HOME/.local/bin:$PATH && SCRIPTC_CC=zigcc scriptc build <file>.ts --dynamic -o /tmp/probe-out\`
   Put the winning probe (and the failing variant) in \`probeEvidence\`. A proposal
   backed by a compiled probe is worth ten proposals backed by reasoning.
3. Prefer, in order: (a) a semantically-equivalent rewrite of pi source, (b) a rewrite in
   the staging transform, (c) an island shim, (d) a change to the local scriptc checkout.
4. Set \`losesFeature: true\` if your approach changes any observable pi behaviour, and
   describe it in \`featureRisk\`. Be honest — a rejected honest proposal is far more
   useful than an accepted dishonest one. If you cannot find a fix that preserves every
   feature, say so with \`confidence: "low"\` and explain what a real fix would require.
5. \`steps\` must be concrete enough for another engineer to apply without re-deriving
   your reasoning: exact files, exact edits, exact new code.

Return the structured proposal.`;

const implementPrompt = (proposal, cluster, round) => `${CONTEXT}

# Your task (round ${round}): apply ONE approved proposal

Another agent researched this cluster and produced the proposal below. Apply it to the
real working tree at ${ROOT} (you are NOT in an isolated worktree; your edits are real).

Cluster: ${cluster.id} — ${cluster.rootCause}
Files the proposal expects to edit:
${(proposal.filesToEdit ?? []).map((f) => `  - ${f}`).join("\n")}

Approach:
${proposal.approach}

Steps:
${(proposal.steps ?? []).map((s, i) => `  ${i + 1}. ${s}`).join("\n")}

${proposal.probeEvidence ? `Probe evidence from the researcher:\n${proposal.probeEvidence}\n` : ""}
Rules for this task:
1. First re-run the staging transform and confirm the diagnostics for this cluster still
   exist; an earlier fix this round may already have resolved them. If they are gone,
   return \`applied: false\` and say so.
2. Stay inside the files listed above. Other agents own other files this round. If the
   fix genuinely requires touching a file outside that list, do it but record it in
   \`deviation\`.
3. Do NOT edit \`.scriptc-stage/\` — it is generated. Fix the source or the transform.
4. If the proposal turns out to be wrong when you try it, do not improvise a
   feature-losing hack. Stop, revert your partial edits with \`git checkout -- <files>\`,
   and return \`applied: false\` with an explanation in \`deviation\`.
5. Before returning, run \`cd ${ROOT} && npm run build\` and set \`piBuildGreen\` to
   whether it exited 0. If it did not, fix your change or revert it.
6. Do not commit. A later step handles committing.

Return the structured result.`;

const reviewPrompt = (round, appliedSummaries) => `${CONTEXT}

# Your task (round ${round}): adversarial review for FEATURE LOSS

Changes were just applied to ${ROOT} to fix scriptc compile errors. Your job is to catch
any change that made the compiler happy by making pi worse. You are the last line of
defence on the project's hardest rule: no feature may be sacrificed.

What the implementers claim they did:
${appliedSummaries.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}

Method:
1. Run \`cd ${ROOT} && git diff\` and read EVERY hunk. Do not trust the summaries above;
   they describe intent, not what actually landed.
2. Flag as feature loss: deleted or short-circuited code paths, functions stubbed to
   return constants or no-ops, error handling replaced by silent catch, removed CLI
   flags/commands/UI affordances, narrowed public types, disabled or deleted tests,
   caches or invalidation logic dropped, behaviour that changes only under a runtime
   condition (a subtle way to hide a regression).
3. Distinguish genuine equivalence from apparent equivalence. Example of GENUINE:
   replacing a WeakMap with a property stored on the key object has the same lifetime.
   Example of LOSS: replacing a WeakMap with a plain Map keyed by id, which leaks.
4. A pure type-level change that does not alter emitted behaviour is acceptable. A cast
   that suppresses a real check is not.
5. Verify \`npm run build\` exits 0 and \`node dist/cli.js --version\` prints 0.84.2.

Set \`verdict: "revert"\` if ANY hunk loses a feature, otherwise \`"accept"\`. Quote the
offending hunks in \`suspiciousHunks\`. Be strict; a false accept is much more costly
than a false revert.`;

const settlePrompt = (round, verdict, before, after, typecheckAfter, reasons) => `${CONTEXT}

# Your task (round ${round}): commit or revert

Facts established this round:
- diagnostics before: ${before}
- diagnostics after: ${after} (of which SC0001 typecheck errors: ${typecheckAfter})
- feature-loss review verdict: ${verdict}
${reasons.length ? `- reviewer reasons:\n${reasons.map((r) => `    - ${r}`).join("\n")}` : ""}

Decide and act in ${ROOT}:

- REVERT (\`git checkout -- . && git clean -fd -- packages scripts\`) if the reviewer said
  "revert", OR if diagnostics went UP, OR if SC0001 is greater than zero while the total
  went down (that is the measurement trap: a typecheck error hid the real count).
- Otherwise COMMIT everything with \`git add -A && git commit --no-verify\` and a message
  of the form:
      scriptc port: <what changed> (${before} -> ${after})

      <why, and any semantics worth recording for the next engineer>
  Never use \`git push\`. Never interact with GitHub.

Report which action you took.`;

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
const seed =
  typeof args === "string"
    ? (() => {
        try {
          return JSON.parse(args);
        } catch {
          return {};
        }
      })()
    : (args ?? {});

const history = [];
const rejectedByCluster = { ...(seed.rejected ?? {}) };
let round = 0;
let dryStreak = 0;
let previousCount = null;
let solved = false;
let stopReason = "max rounds reached";

while (round < MAX_ROUNDS) {
  round += 1;

  phase("Measure");
  const measured = await agent(measurePrompt(round), {
    label: `measure:r${round}`,
    phase: "Measure",
    model: "openai-codex/gpt-5.6-luna",
    thinkingLevel: "xhigh",
    schema: MEASURE,
  });

  if (!measured) {
    stopReason = "measurement agent failed";
    log("measure agent returned null; stopping");
    break;
  }

  const count = measured.errorCount ?? 0;
  log(`round ${round}: ${count} diagnostics (${measured.typecheckErrorCount ?? 0} typecheck)`);

  if (count === 0 && measured.buildSucceeded) {
    solved = true;
    stopReason = measured.binaryRuns
      ? "pi compiled and the binary runs"
      : "pi compiled but the binary did not run cleanly";
    history.push({ round, count, action: "solved" });
    break;
  }

  if (previousCount !== null) {
    if (count >= previousCount) {
      dryStreak += 1;
      log(`no progress (${previousCount} -> ${count}); dry streak ${dryStreak}/${MAX_DRY_STREAK}`);
    } else {
      dryStreak = 0;
    }
  }
  if (dryStreak >= MAX_DRY_STREAK) {
    stopReason = `no progress for ${MAX_DRY_STREAK} consecutive rounds`;
    break;
  }
  previousCount = count;

  // Pick clusters with DISJOINT file ownership so proposals cannot collide.
  const owned = new Set();
  const selected = [];
  for (const cluster of (measured.clusters ?? []).slice().sort((a, b) => (b.errorCount ?? 0) - (a.errorCount ?? 0))) {
    if (selected.length >= CLUSTERS_PER_ROUND) break;
    const files = cluster.files ?? [];
    if (files.some((f) => owned.has(f))) {
      log(`deferring cluster ${cluster.id}: file overlap with a cluster already selected`);
      continue;
    }
    files.forEach((f) => owned.add(f));
    selected.push(cluster);
  }

  if (!selected.length) {
    stopReason = "no actionable clusters were reported";
    break;
  }
  log(`round ${round}: working ${selected.map((c) => c.id).join(", ")}`);

  phase("Research");
  const proposals = await parallel(
    selected.map((cluster) => () =>
      agent(researchPrompt(cluster, round, rejectedByCluster[cluster.id] ?? []), {
        label: `research:${cluster.id}`,
        phase: "Research",
        model: "openai-codex/gpt-5.6-luna",
        thinkingLevel: "xhigh",
        isolation: READ_ONLY,
        schema: PROPOSAL,
      }),
    ),
  );

  proposals.forEach((proposal, i) => {
    if (!proposal) log(`research for ${selected[i].id} returned null`);
  });

  const usable = proposals
    .map((proposal, i) => ({ proposal, cluster: selected[i] }))
    .filter((entry) => entry.proposal && !entry.proposal.losesFeature && entry.proposal.confidence !== "low");

  for (const { proposal, cluster } of proposals
    .map((proposal, i) => ({ proposal, cluster: selected[i] }))
    .filter((entry) => entry.proposal && (entry.proposal.losesFeature || entry.proposal.confidence === "low"))) {
    const why = proposal.losesFeature
      ? `would lose a feature: ${proposal.featureRisk ?? "unspecified"}`
      : `low confidence: ${proposal.approach}`;
    log(`skipping ${cluster.id} — ${why}`);
    rejectedByCluster[cluster.id] = [...(rejectedByCluster[cluster.id] ?? []), `${proposal.approach} (${why})`];
  }

  if (!usable.length) {
    log(`round ${round}: no feature-preserving proposal survived; retrying with different clusters next round`);
    history.push({ round, count, action: "no usable proposal" });
    continue;
  }

  // Implementation is SEQUENTIAL on purpose: several clusters can legitimately need to
  // touch the shared staging scripts, and parallel writers would clobber each other.
  phase("Implement");
  const applied = [];
  for (const { proposal, cluster } of usable) {
    const result = await agent(implementPrompt(proposal, cluster, round), {
      label: `implement:${cluster.id}`,
      phase: "Implement",
      model: "openai-codex/gpt-5.6-luna",
      thinkingLevel: "xhigh",
      schema: IMPLEMENTED,
    });
    if (result?.applied) {
      applied.push(`${cluster.id}: ${result.summary}`);
    } else {
      const why = result?.deviation ?? "implementer returned null";
      log(`implement ${cluster.id} did not apply — ${why}`);
      rejectedByCluster[cluster.id] = [...(rejectedByCluster[cluster.id] ?? []), `${proposal.approach} (failed in practice: ${why})`];
    }
  }

  if (!applied.length) {
    history.push({ round, count, action: "nothing applied" });
    continue;
  }

  phase("Verify");
  const verified = await agent(
    `${CONTEXT}\n\n# Your task (round ${round}): re-measure after changes\n\n` +
      `Fixes were just applied to ${ROOT}. Re-run the staging transform and the scriptc build exactly as ` +
      `documented above, logging to /tmp/fixloop-r${round}-after.txt, and report the new counts.\n\n` +
      `Report \`errorCount\` (grep -c 'error SC') and \`typecheckErrorCount\` (grep -c 'error SC0001') ` +
      `separately — remember the measurement trap. Set \`buildSucceeded\` only if the compiler produced ` +
      `/tmp/pi-native, and \`binaryRuns\` only if \`/tmp/pi-native --version\` actually works.\n\n` +
      `Cluster the remaining diagnostics as before. Fix nothing.`,
    {
      label: `verify:r${round}`,
      phase: "Verify",
      model: "openai-codex/gpt-5.6-luna",
      thinkingLevel: "xhigh",
      schema: MEASURE,
    },
  );

  const after = verified?.errorCount ?? count;
  const typecheckAfter = verified?.typecheckErrorCount ?? 0;

  const review = await agent(reviewPrompt(round, applied), {
    label: `review:r${round}`,
    phase: "Verify",
    model: "anthropic/claude-opus-5",
    thinkingLevel: "xhigh",
    schema: REVIEW,
  });

  const verdict = review?.verdict ?? "revert";
  if (!review) log(`round ${round}: review agent returned null; defaulting to revert`);

  const settled = await agent(
    settlePrompt(round, verdict, count, after, typecheckAfter, review?.reasons ?? []),
    {
      label: `settle:r${round}`,
      phase: "Verify",
      model: "openai-codex/gpt-5.6-sol",
      thinkingLevel: "medium",
      schema: SETTLE,
    },
  );

  if (settled?.action === "reverted") {
    for (const { proposal, cluster } of usable) {
      rejectedByCluster[cluster.id] = [
        ...(rejectedByCluster[cluster.id] ?? []),
        `${proposal.approach} (reverted: ${(review?.reasons ?? []).join("; ") || "regressed the error count"})`,
      ];
    }
    previousCount = count;
  } else if (settled?.action === "committed") {
    previousCount = after;
  }

  history.push({
    round,
    before: count,
    after,
    typecheckAfter,
    verdict,
    action: settled?.action ?? "unknown",
    clusters: usable.map((entry) => entry.cluster.id),
  });
  log(`round ${round}: ${count} -> ${after} (${settled?.action ?? "unknown"})`);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
phase("Report");
const report = await agent(
  `${CONTEXT}\n\n# Your task: write the final status report\n\n` +
    `An automated fix loop just finished. Stop reason: ${stopReason}. Solved: ${solved}.\n\n` +
    `Round history:\n${JSON.stringify(history, null, 2)}\n\n` +
    `Approaches rejected along the way:\n${JSON.stringify(rejectedByCluster, null, 2)}\n\n` +
    `Do this:\n` +
    `1. In ${ROOT}, run the staging transform and build once more to establish the true ` +
    `current count, and run \`git log --oneline\` to see what actually landed.\n` +
    `2. Confirm pi's own build is still green (\`npm run build\`, \`node dist/cli.js --version\`).\n` +
    `3. Rewrite /home/gustavo/src/scriptc-pi-status.md to reflect reality: the error ` +
    `trajectory, what was fixed and why each fix preserves behaviour, what was tried and ` +
    `reverted (so it is not retried), the remaining diagnostics grouped by root cause, and ` +
    `the unstarted integrations (node:sqlite via --ffi, clipboard via subprocess, wiring the ` +
    `extension loader).\n` +
    `4. Be honest in the summary. If pi still does not compile, say so plainly in the first ` +
    `paragraph rather than burying it. Do not describe partial progress as success.\n\n` +
    `Return a short plain-text summary of the final state.`,
  {
    label: "final report",
    phase: "Report",
    model: "anthropic/claude-opus-4-8",
    thinkingLevel: "xhigh",
  },
);

return {
  solved,
  stopReason,
  rounds: history.length,
  finalErrorCount: previousCount,
  history,
  rejectedApproaches: rejectedByCluster,
  report,
};
