import type { BenchVerifier } from "./bench-types";

export type ChecklistAxis = "grounding" | "coverage" | "actionability" | "testing" | "scope";

export interface ChecklistItem {
  id: string;
  text: string;
  points: number;
  axis: ChecklistAxis;
}

export interface BenchTaskRepo {
  // At least one source is required. `sourcePath` is a machine-local checkout
  // (fast `git clone --local`, works offline, private repos). `gitUrl` is a
  // remote fallback so a portable task can be snapshotted on any device that
  // lacks the local checkout. When both are set, the local path wins if it
  // exists, otherwise the URL is cloned.
  sourcePath?: string;
  gitUrl?: string;
  dirName?: string; // stable snapshot folder name (defaults to basename of sourcePath/gitUrl)
  pinnedCommit: string;
  stripGlobs: string[];
}

export interface BenchTask {
  id: string;
  title: string;
  summary: string;
  prompt: string;
  repos: BenchTaskRepo[];
  checklist: ChecklistItem[];
  tags: string[];
  builtIn: boolean;
  // When present, this task can be run in execution mode: contenders implement
  // real code and are scored by these deterministic checks (pass@1) instead of
  // an LLM judge. See lib/bench-verifier.ts for the step semantics.
  verifier?: BenchVerifier;
}

export const DEFAULT_STRIP_GLOBS = [
  "fuse-plan-*.md",
  "*_PLAN.md",
  "PLAN-*.md",
  "REVIEW-*.md",
  "PARITY_FINDINGS.md",
  "BLOG_*_PLAN.md",
  "SEO_*_PLAN.md",
  "SOCIAL_*_PLAN.md",
];

const MIGMA_FRONTEND = "/Users/liam/migma-both/frontend";
const MIGMA_BACKEND = "/Users/liam/migma-both/backend";
const FUSE_REPO = "/Users/liam/projects/fuse";

const MIGMA_FRONTEND_BASE = "affe8d2d";
const MIGMA_BACKEND_BASE = "3e45e41";
const MIGMA_FRONTEND_AUTHOR_LOCATION_BASE = "22aaf305";
const MIGMA_BACKEND_AUTHOR_LOCATION_BASE = "57332c2";
const FUSE_MODE_BADGES_BASE = "14d9ab2";

const frontendRepo = (pinnedCommit = MIGMA_FRONTEND_BASE): BenchTaskRepo => ({
  sourcePath: MIGMA_FRONTEND,
  pinnedCommit,
  stripGlobs: DEFAULT_STRIP_GLOBS,
});

const backendRepo = (pinnedCommit = MIGMA_BACKEND_BASE): BenchTaskRepo => ({
  sourcePath: MIGMA_BACKEND,
  pinnedCommit,
  stripGlobs: DEFAULT_STRIP_GLOBS,
});

// The Fuse repo is public, so its task carries a `gitUrl` fallback: users who
// don't have Liam's local checkout still snapshot it by cloning from GitHub at
// the pinned commit. Any commit referenced here MUST be on origin/main.
const FUSE_GIT_URL = "https://github.com/LiamBCN/fuse.git";

const fuseRepo = (pinnedCommit = FUSE_MODE_BADGES_BASE): BenchTaskRepo => ({
  gitUrl: FUSE_GIT_URL,
  sourcePath: FUSE_REPO,
  dirName: "fuse",
  pinnedCommit,
  stripGlobs: DEFAULT_STRIP_GLOBS,
});

// All built-in task literals live in these two internal arrays; the exported
// `DEFAULT_TASKS` (visible + runnable in the picker) and `ADDITIONAL_BENCH_TASKS`
// (parked, hidden) are derived from them by id below, so promoting/demoting a
// task is a one-line change to VISIBLE_BUILTIN_IDS — no moving big literals.
const PRIMARY_TASKS: BenchTask[] = [
  {
    id: "migma-author-location-fields",
    title: "Author Location Fields",
    summary: "Add optional country and city author fields in blog admin, then show them on public author and article surfaces.",
    prompt:
      "Make a plan where we, in the admin panel inside the blog administration page. We need to add for author dialog when user is adding a new author a country and city inputs. After that, we need to show that in the author public page and articles published by the author.",
    repos: [
      backendRepo(MIGMA_BACKEND_AUTHOR_LOCATION_BASE),
      frontendRepo(MIGMA_FRONTEND_AUTHOR_LOCATION_BASE),
    ],
    tags: ["cross-stack", "blog", "authors", "public-pages"],
    builtIn: true,
    // Execution scoring (structural, diff-based — needs no deps, runs in ms).
    // Hard steps gate `resolved`: the feature is only "done" if BOTH stacks
    // gain BOTH fields. The structured-data / public-render checks are soft
    // (valid implementations vary) but still count toward the step-pass ratio.
    verifier: {
      steps: [
        { kind: "diff", label: "Backend adds country", repo: "backend", pattern: "country" },
        { kind: "diff", label: "Backend adds city", repo: "backend", pattern: "city" },
        { kind: "diff", label: "Frontend adds country", repo: "frontend", pattern: "country" },
        { kind: "diff", label: "Frontend adds city", repo: "frontend", pattern: "city" },
        { kind: "diff", label: "Author form gains a Country/City input", repo: "frontend", pattern: "(label|placeholder|name)[^\\n]{0,40}(country|city)" },
        { kind: "diff", label: "Structured data / address surfaced", repo: "frontend", pattern: "addressCountry|addressLocality|addressRegion", soft: true },
        { kind: "diff", label: "No required-field migration forced", pattern: "required:\\s*true[^\\n]{0,30}(city|country)", want: false, soft: true },
      ],
    },
    checklist: [
      {
        id: "t0-author-types",
        text: "Extends the backend and frontend author contracts with separate optional city and country fields instead of a single combined location string.",
        points: 4,
        axis: "coverage",
      },
      {
        id: "t0-backend-validation",
        text: "Updates the existing author create/update validation and service allowlists to persist city/country safely through the current author endpoints.",
        points: 4,
        axis: "coverage",
      },
      {
        id: "t0-optional-no-migration",
        text: "Keeps city and country optional for existing authors and avoids an unnecessary migration/backfill requirement.",
        points: 3,
        axis: "scope",
      },
      {
        id: "t0-admin-dialog",
        text: "Adds City and Country inputs to the existing blog admin author dialog, including form state, reset, edit hydration, and create/update payloads.",
        points: 5,
        axis: "coverage",
      },
      {
        id: "t0-admin-existing-service",
        text: "Keeps admin writes going through the existing frontend AuthorService/API client instead of adding raw fetch calls or new author routes.",
        points: 3,
        axis: "actionability",
      },
      {
        id: "t0-public-author-page",
        text: "Shows a formatted location on the public author page when either field exists and omits it cleanly when both are empty.",
        points: 4,
        axis: "coverage",
      },
      {
        id: "t0-public-article-surfaces",
        text: "Shows author location on public article surfaces that display author details, including the article detail byline/author block and relevant article cards or lists.",
        points: 4,
        axis: "coverage",
      },
      {
        id: "t0-location-formatting",
        text: "Defines or reuses a formatter that renders City, Country; City-only; or Country-only without dangling commas or empty separators.",
        points: 3,
        axis: "actionability",
      },
      {
        id: "t0-structured-data",
        text: "Updates relevant Person/Article structured data only when location exists, using addressLocality/addressCountry or equivalent conservative schema fields.",
        points: 3,
        axis: "coverage",
      },
      {
        id: "t0-revalidation",
        text: "Accounts for public page/cache revalidation after author location changes so author and article pages do not serve stale author details.",
        points: 2,
        axis: "actionability",
      },
      {
        id: "t0-focused-tests",
        text: "Verification covers backend create/update/clear behavior, admin add/edit dialog payloads, public author rendering, article rendering, and old authors without location.",
        points: 4,
        axis: "testing",
      },
      {
        id: "t0-required-fields",
        text: "Makes city or country required, or blocks existing authors/articles that lack these fields.",
        points: -5,
        axis: "scope",
      },
      {
        id: "t0-frontend-only",
        text: "Only changes frontend display/form code without adding backend validation and persistence for the new fields.",
        points: -5,
        axis: "coverage",
      },
      {
        id: "t0-new-author-route",
        text: "Invents a new author-location endpoint or public author fetch path when the existing author create/update and populated blog data flows are sufficient.",
        points: -4,
        axis: "scope",
      },
      {
        id: "t0-empty-location-ui",
        text: "Plans public UI that can render blank location rows, dangling commas, or noisy repeated location text on every card.",
        points: -4,
        axis: "coverage",
      },
    ],
  },
  {
    id: "migma-admin-panel-rbac",
    title: "Admin Panel RBAC",
    summary: "Add three scoped internal admin roles across JWT auth, admin APIs, navigation, and team management.",
    prompt:
      "Add three internal admin panel roles on top of the existing Migma JWT auth system. Full Admin can access the whole admin panel and manage team members. Blog Editor can only access the Blog page and its article/author write flows. Blog + Redesign can access Blog plus the Redesign Pipeline, and nothing else. Add an Admin Panel entry in the user profile dropdown for anyone with an admin role, route limited users to their correct landing page, and add a Team section where full admins can grant, change, or revoke these roles for existing Migma users.",
    repos: [backendRepo(), frontendRepo()],
    tags: ["cross-stack", "auth", "admin", "rbac"],
    builtIn: true,
    checklist: [
      {
        id: "t1-fresh-user-doc",
        text: "Identifies that authenticated requests load a fresh User document and uses it, not only stale JWT role claims, for grant/revoke freshness.",
        points: 4,
        axis: "grounding",
      },
      {
        id: "t1-dedicated-admin-access",
        text: "Plans an additive admin-panel access model or helper instead of overloading existing customer organization, seat, or billing roles.",
        points: 4,
        axis: "coverage",
      },
      {
        id: "t1-backend-middleware",
        text: "Adds backend middleware that permits full admin everywhere and section-scoped access for blog and redesign pipeline routes.",
        points: 4,
        axis: "coverage",
      },
      {
        id: "t1-deny-default",
        text: "Requires unmapped admin-adam API paths to remain full-admin-only by default.",
        points: 3,
        axis: "scope",
      },
      {
        id: "t1-blog-author-writes",
        text: "Covers blog and author write routes separately from admin-adam, including create/update/delete, image upload, and AI generation endpoints.",
        points: 3,
        axis: "coverage",
      },
      {
        id: "t1-profile-access-shape",
        text: "Returns a computed admin access shape from the profile endpoint so frontend routing does not duplicate role mapping logic blindly.",
        points: 3,
        axis: "actionability",
      },
      {
        id: "t1-frontend-route-guard",
        text: "Updates the admin layout guard to redirect section-limited users away from forbidden admin pages to their default permitted route.",
        points: 3,
        axis: "coverage",
      },
      {
        id: "t1-sidebar-and-dropdown",
        text: "Filters the admin sidebar by permitted sections and adds or fixes the profile dropdown Admin Panel entry for desktop and mobile.",
        points: 3,
        axis: "coverage",
      },
      {
        id: "t1-team-management",
        text: "Includes a full-admin-only team management API and UI for list, grant, role change, revoke, and clear existing-account-by-email behavior.",
        points: 4,
        axis: "coverage",
      },
      {
        id: "t1-admin-safety-guards",
        text: "Includes self-demotion and last-full-admin protections plus an audit trail for grants, changes, and revokes.",
        points: 3,
        axis: "actionability",
      },
      {
        id: "t1-route-matrix-tests",
        text: "Specifies backend route-matrix tests for full admin, blog editor, blog+redesign, ordinary user, and revoke freshness.",
        points: 3,
        axis: "testing",
      },
      {
        id: "t1-fabricates-org-seats",
        text: "Claims staff admin access should be implemented through customer organizations, project members, Stripe seats, or invitations as the core mechanism.",
        points: -5,
        axis: "grounding",
      },
      {
        id: "t1-fabricates-single-router",
        text: "Treats all blog writes as living under the admin-adam router and misses the separate blog/authors routers.",
        points: -4,
        axis: "grounding",
      },
      {
        id: "t1-weakens-admin",
        text: "Weakens the existing full-admin guard globally without preserving full-admin-only behavior for unrelated admin APIs.",
        points: -5,
        axis: "scope",
      },
    ],
  },
  {
    id: "migma-blog-dates",
    title: "Blog Published + Updated Dates",
    summary: "Expose published and last-updated timestamps on public articles, admin editing, metadata, schema, and sitemap.",
    prompt:
      "Show each article's published date and last updated date after edits. The public blog article page should display the published date and, when meaningfully different, the last updated date. The admin editor should expose the article's timestamps. SEO metadata, Open Graph, JSON-LD/schema.org, and sitemap lastModified should consistently use the existing published and updated timestamps without adding duplicate database fields.",
    repos: [frontendRepo()],
    tags: ["frontend", "blog", "seo", "small-scope"],
    builtIn: true,
    checklist: [
      {
        id: "t2-existing-fields",
        text: "Recognizes the existing blog date/createdAt/updatedAt fields as the source of truth and avoids proposing a migration for duplicate timestamp fields.",
        points: 4,
        axis: "grounding",
      },
      {
        id: "t2-public-time-elements",
        text: "Plans visible public article markup with published and last-updated time elements using stable dateTime values.",
        points: 3,
        axis: "coverage",
      },
      {
        id: "t2-meaningful-threshold",
        text: "Avoids showing a redundant last-updated label when updatedAt is effectively the same as the publish date.",
        points: 2,
        axis: "scope",
      },
      {
        id: "t2-admin-properties",
        text: "Adds read-only timestamp display in the admin editor or article properties panel with clear labels for draft created, published, and last updated.",
        points: 3,
        axis: "coverage",
      },
      {
        id: "t2-schema-dates",
        text: "Updates or verifies JSON-LD BlogPosting/WebPage datePublished and dateModified fields use date and updatedAt consistently.",
        points: 3,
        axis: "coverage",
      },
      {
        id: "t2-og-dates",
        text: "Updates or verifies Next metadata/Open Graph article published and modified times without introducing conflicting duplicate tags.",
        points: 2,
        axis: "coverage",
      },
      {
        id: "t2-sitemap",
        text: "Checks sitemap lastModified and switches it to updatedAt || date where needed.",
        points: 2,
        axis: "coverage",
      },
      {
        id: "t2-silent-edit",
        text: "Preserves the existing silent/minor edit behavior so typo-only edits do not fake content freshness.",
        points: 3,
        axis: "scope",
      },
      {
        id: "t2-revalidation",
        text: "Keeps blog page revalidation aligned with edits so public HTML, metadata, and structured data update after save.",
        points: 2,
        axis: "actionability",
      },
      {
        id: "t2-focused-tests",
        text: "Testing plan includes public render/schema assertions and admin timestamp save behavior rather than broad unrelated backend tests.",
        points: 2,
        axis: "testing",
      },
      {
        id: "t2-invents-backend-schema",
        text: "Proposes new backend date columns or a Mongo migration as required for this task without first using the existing timestamp fields.",
        points: -4,
        axis: "scope",
      },
      {
        id: "t2-fakes-freshness",
        text: "Suggests always setting modified dates to now at render time or otherwise fabricating freshness outside the saved article data.",
        points: -5,
        axis: "grounding",
      },
    ],
  },
];

// Parked built-in tasks. Add an id to VISIBLE_BUILTIN_IDS below to surface one.
const PARKED_TASKS: BenchTask[] = [
  {
    id: "migma-author-email-team",
    title: "Author Email Autogen + Migma Team",
    summary: "Remove author email entry, generate safe internal emails, and reassign deleted authors' posts to a protected team author.",
    prompt:
      "When adding a blog author, do not ask the marketer for an email address. Generate the required unique author email behind the scenes from the author's first name at migma.ai. When deleting an author who has published articles, reassign those articles to a protected 'Migma Team' author instead of blocking deletion. The Migma Team author must be visible in the authors list, editable, and impossible to delete.",
    repos: [backendRepo(), frontendRepo()],
    tags: ["cross-stack", "blog", "data-flow", "authors"],
    builtIn: true,
    checklist: [
      {
        id: "t3-author-email-required",
        text: "Identifies the backend Author email requirement and unique index while removing email from marketer-facing create flows.",
        points: 4,
        axis: "grounding",
      },
      {
        id: "t3-generate-email",
        text: "Generates an internal migma.ai email from the first usable name token with deterministic suffixing for collisions.",
        points: 4,
        axis: "coverage",
      },
      {
        id: "t3-explicit-email-compat",
        text: "Keeps explicit email input backward-compatible at the API level while no longer requiring it from the admin UI.",
        points: 2,
        axis: "scope",
      },
      {
        id: "t3-default-author-bootstrap",
        text: "Makes a single protected Migma Team/default author visible by bootstrapping it on authors-list reads or equivalent safe path.",
        points: 4,
        axis: "coverage",
      },
      {
        id: "t3-default-author-immutable",
        text: "Preserves the default author's delete protection and prevents clients from flipping isDefault through create/update bodies.",
        points: 3,
        axis: "actionability",
      },
      {
        id: "t3-reassign-delete",
        text: "On author delete, reassigns matching blog docs to the Migma Team author before deleting the original author.",
        points: 4,
        axis: "coverage",
      },
      {
        id: "t3-legacy-email-linked",
        text: "Covers legacy blogs linked only by authorEmail as well as newer authorId-linked posts.",
        points: 3,
        axis: "grounding",
      },
      {
        id: "t3-frontend-forms",
        text: "Removes email validation, email input fields, and email payloads from both author creation forms.",
        points: 3,
        axis: "coverage",
      },
      {
        id: "t3-delete-copy-count",
        text: "Updates delete confirmation and success feedback to explain reassignment to Migma Team and surface reassigned counts.",
        points: 2,
        axis: "actionability",
      },
      {
        id: "t3-revalidation",
        text: "Revalidates affected public blog and author pages after reassignment so stale bylines are not served.",
        points: 3,
        axis: "coverage",
      },
      {
        id: "t3-tests",
        text: "Testing covers email collision generation, default author singleton behavior, delete reassignment, protected default delete, and both UI create flows.",
        points: 3,
        axis: "testing",
      },
      {
        id: "t3-renames-default-flag",
        text: "Renames isDefault to a new protected/system flag without accounting for existing read-time fallback code.",
        points: -4,
        axis: "grounding",
      },
      {
        id: "t3-blocks-delete",
        text: "Blocks deleting authors with posts instead of implementing reassignment to Migma Team.",
        points: -5,
        axis: "coverage",
      },
      {
        id: "t3-touches-blog-author-email",
        text: "Changes blog.authorEmail semantics as the primary fix even though it is an existing creator/login linkage.",
        points: -4,
        axis: "grounding",
      },
    ],
  },
  {
    id: "fuse-mode-badges-live-run",
    title: "Fuse Mode Badges + Live Run Diagram",
    summary: "Persist mode on assistant turns and stream per-stage state for an expandable live plan diagram.",
    prompt:
      "Add mode visibility and a live expandable run diagram to Fuse. Every assistant reply should record which plan mode produced it and show a mode badge in chat, history, and the per-conversation debug view. While a plan is generating, the progress block should expand into a live vertical pipeline diagram driven by structured stage events, with running/done/error/skipped status, streamed text tails where available, final stage output available after completion, and a minimize path back to the compact progress bar.",
    repos: [fuseRepo()],
    tags: ["fuse", "frontend", "runtime", "sse"],
    builtIn: true,
    checklist: [
      {
        id: "t4-mode-persist",
        text: "Adds mode to the shared Turn/result/runtime types and persists it on assistant turns for new conversations.",
        points: 4,
        axis: "coverage",
      },
      {
        id: "t4-legacy-inference",
        text: "Keeps a fallback inference path for legacy conversations that lack stored mode.",
        points: 2,
        axis: "scope",
      },
      {
        id: "t4-stage-types",
        text: "Defines a client-safe StageInfo model with key, title, provider/model, status, chars/tail/output/error, and timestamps.",
        points: 3,
        axis: "coverage",
      },
      {
        id: "t4-provider-tail",
        text: "Extends provider activity so Claude streaming stages can emit a capped live text tail while Codex can still report progress safely.",
        points: 3,
        axis: "actionability",
      },
      {
        id: "t4-runplan-stage-events",
        text: "Wires runPlan stage lifecycle events through clarify/recon/drafts/verify/synthesize/finalize, including retry and failure paths.",
        points: 5,
        axis: "coverage",
      },
      {
        id: "t4-sse-merge",
        text: "Sends additive SSE stage events and merges them in the runtime by stage key without dropping previously received outputs.",
        points: 4,
        axis: "coverage",
      },
      {
        id: "t4-live-view",
        text: "Builds an expandable LiveRunView that mirrors the pipeline visual language, auto-expands running stages, and lets users reopen completed outputs.",
        points: 4,
        axis: "coverage",
      },
      {
        id: "t4-autoscroll",
        text: "Suppresses transcript autoscroll while the expanded live view is open so users can read streaming output.",
        points: 2,
        axis: "actionability",
      },
      {
        id: "t4-history-badges",
        text: "Shows mode badges in chat, history cards, and history debug assistant turns.",
        points: 3,
        axis: "coverage",
      },
      {
        id: "t4-tests",
        text: "Verification includes typecheck/build plus manual Fast and Recon runs confirming stage events, collapse behavior, and persisted badges.",
        points: 3,
        axis: "testing",
      },
      {
        id: "t4-invents-websocket",
        text: "Replaces the existing SSE runtime with a new transport instead of adding structured events to the current stream.",
        points: -4,
        axis: "scope",
      },
      {
        id: "t4-loses-outputs",
        text: "Only streams transient tails and does not preserve completed stage outputs for later expansion.",
        points: -4,
        axis: "coverage",
      },
    ],
  },
  {
    id: "migma-draft-workflow-trap",
    title: "Groundedness Trap: Draft Workflow",
    summary: "A deliberately leading request that should trigger NOT FOUND / create-first planning rather than fabricated existing flows.",
    prompt:
      "Extend the existing draft-articles workflow so blog editors can bulk promote draft articles from the current draft review queue, preserve the current Notion draft synchronization rules, and keep the existing draft-to-published audit trail intact. Please plan the smallest safe implementation.",
    repos: [frontendRepo()],
    tags: ["frontend", "trap", "grounding", "blog"],
    builtIn: true,
    checklist: [
      {
        id: "t5-states-not-found",
        text: "Explicitly says the existing draft review queue, Notion draft synchronization rules, or audit trail must be verified and may not exist.",
        points: 5,
        axis: "grounding",
      },
      {
        id: "t5-inspection-first",
        text: "Starts with codebase investigation steps for blog admin routes, services, Notion/editor code, and any draft/publish representation before designing changes.",
        points: 4,
        axis: "actionability",
      },
      {
        id: "t5-create-first",
        text: "If the requested workflow is absent, plans to create the missing workflow deliberately instead of pretending to extend it.",
        points: 4,
        axis: "grounding",
      },
      {
        id: "t5-public-draft-safety",
        text: "Includes public draft-leak checks for article detail, lists, author/category pages, search, sitemap, and metadata before bulk promotion.",
        points: 3,
        axis: "coverage",
      },
      {
        id: "t5-admin-gating",
        text: "Keeps blog-editor/admin authorization separate from public blog surfaces and does not grant broad admin access by accident.",
        points: 2,
        axis: "scope",
      },
      {
        id: "t5-audit-design",
        text: "Treats the audit trail as a required design artifact to verify or add, with actor, action, timestamps, and affected article ids.",
        points: 3,
        axis: "coverage",
      },
      {
        id: "t5-fabricates-queue",
        text: "Claims there is already a draft review queue component, route, or API without citing real paths from the repo.",
        points: -6,
        axis: "grounding",
      },
      {
        id: "t5-fabricates-notion-sync",
        text: "Claims specific Notion draft synchronization behavior exists without verifying it in the code.",
        points: -6,
        axis: "grounding",
      },
      {
        id: "t5-fabricates-audit",
        text: "Claims a draft-to-published audit trail already exists without verifying real storage or route code.",
        points: -5,
        axis: "grounding",
      },
      {
        id: "t5-overbuilds",
        text: "Designs a large workflow engine or unrelated editorial system before establishing the current app's actual blog primitives.",
        points: -3,
        axis: "scope",
      },
    ],
  },
];

// The task picker shows exactly these, in this order. Everything else built-in
// stays parked (hidden but runnable-by-id only if promoted here).
const VISIBLE_BUILTIN_IDS = ["migma-author-location-fields", "fuse-mode-badges-live-run"];

export const ALL_BUILTIN_TASKS: BenchTask[] = [...PRIMARY_TASKS, ...PARKED_TASKS];

const builtinById = new Map(ALL_BUILTIN_TASKS.map((task) => [task.id, task]));

export const DEFAULT_TASKS: BenchTask[] = VISIBLE_BUILTIN_IDS.map((id) => builtinById.get(id)).filter(
  (task): task is BenchTask => !!task,
);

export const ADDITIONAL_BENCH_TASKS: BenchTask[] = ALL_BUILTIN_TASKS.filter(
  (task) => !VISIBLE_BUILTIN_IDS.includes(task.id),
);

export function findDefaultTask(id: string): BenchTask | undefined {
  return DEFAULT_TASKS.find((task) => task.id === id);
}
