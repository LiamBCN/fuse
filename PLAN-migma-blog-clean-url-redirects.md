# PLAN: Migma Blog — Clean URLs + 301 Redirects

**Repos:**
- Frontend: `/Users/liam/migma-both/frontend` (Next.js — public post page at `app/(public)/blog/[id]/page.tsx`, redirects already configured in `next.config.mjs`)
- Backend: `/Users/liam/migma-both/backend` (slugs stored on Mongo `blogs.slug`, generated in `src/services/blog.service.ts`)

**Request:** Remove the random ID suffix from 23 blog article URLs (e.g. `...-slack-mpksi6n4` → `...-slack`) and 301-redirect every old URL to its clean counterpart, without hurting SEO or page performance, organized so it's trivially removable later.

---

## Verdict: WORTH IT — do it, but do the minimal version (~1–2 hours total)

**Why yes, despite low traffic today:**
1. **The cost is near zero.** Static redirects in `next.config.mjs` are compiled into the routing manifest at build time. They are matched only when a request hits one of the 23 old paths — they add **no runtime cost to any other page** and no measurable cost even to the redirected ones (a header-level response, no rendering). 23 entries is nothing; Next.js handles thousands of these fine. The "skip redirects if they hurt performance" escape hatch in the request does not apply — they don't.
2. **Blog SEO is the compounding asset for a startup.** Content marketing is the one channel where today's work pays off for years. Google has these 23 URLs indexed, and every backlink/share/Discord post points at the suffixed versions. Changing the slugs *without* redirects 404s all of it — you'd throw away the small amount of SEO equity you have exactly when it's hardest to earn. 301/308 passes essentially all link equity.
3. **It's a closed, non-growing list.** The current generator (`blog.service.ts` → `ensureUniqueSlug`) no longer appends random suffixes — it uses `-2`, `-3` only on real title collisions. The random endings are **legacy data on exactly these 23 documents**. So this is a one-time cleanup, not an ongoing maintenance burden. That's what makes it sustainable.

**Why the minimal version:** don't build a generic "strip random suffix" middleware. A regex like `-[a-z0-9]{8}$` can false-positive on legitimate future slugs (e.g. a post ending in a product name or year-word), runs on every request, and encodes a rule for a pattern that will never be produced again. A static 23-entry map is explicit, auditable, zero-risk, and deletable in one commit.

**When it would NOT be worth it:** if you were about to migrate the blog to a different platform/domain anyway, or delete these posts. Neither is the case.

---

## Ground truth (verified in code — do not re-derive)

| Fact | Location |
|---|---|
| Public post route is `/blog/[id]`; resolves by slug (or ObjectId) | `frontend/app/(public)/blog/[id]/page.tsx` |
| Slugs live in Mongo `blogs.slug`; unique-suffix logic is `-2`, `-3`… (no random chars anymore) | `backend/src/services/blog.service.ts:303–322` (`ensureUniqueSlug`), `slugifyTitle` at 217 |
| Slug edit support exists: `isSlugAvailable(slug, excludeId)` + admin editor accepts `blogData.slug` | `blog.service.ts:324–343`, `createBlog`/update paths |
| Blog updates queue ISR revalidation (`revalidateBlogPages({ slug, id })`) — pages regenerate automatically after a slug change | `blog.service.ts` (`queueBlogRevalidation`) |
| `next.config.mjs` already has an `async redirects()` block with permanent entries (`/privacy`, `/terms`, `/templates`) — follow that pattern | `frontend/next.config.mjs:14+` |
| `app/sitemap.ts` builds URLs from live slugs — it self-corrects once slugs change; no edits needed | `frontend/app/sitemap.ts` |
| No `vercel.json` / `wrangler.toml` in the frontend — redirects must live in `next.config.mjs` (works on any Next host) | repo root |
| Blogs have an optional `canonicalUrl` field — must check none of the 23 has an old-URL canonical baked in | `blog.service.ts` (`createBlog` fields) |

**Note on 301 vs 308:** Next.js `permanent: true` emits **308**, not 301. Google treats 301 and 308 identically for ranking/equity transfer (both are permanent). Do not fight the framework to force a literal 301; 308 also preserves the request method, which is strictly safer.

---

## Phase 1 — Data: rename the 23 slugs in Mongo

The redirect is only half the job — the articles must actually live at the clean slugs first, or the redirect targets 404.

1. Write a one-off script `backend/scripts/clean-blog-slugs.ts` (or run via admin editor manually — 23 posts is borderline; script is safer and reviewable):
   - Hardcode the 23 `{ oldSlug, newSlug }` pairs from the request (single source of truth — see Phase 2 for sharing it with the frontend).
   - For each pair: `findOne({ slug: oldSlug })`; skip with a logged warning if missing; check `isSlugAvailable(newSlug)`-style uniqueness; `updateOne` setting `slug: newSlug` and `updatedAt`.
   - After each update, trigger the existing revalidation path (`revalidateBlogPages({ slug: newSlug, id })`) so ISR pages regenerate — or simply redeploy the frontend after the batch.
2. While in the script, also check/fix per-document: `canonicalUrl` containing an old suffixed URL, and old-slug cross-links inside other posts' `content` (`db.blogs.find({ content: /-mpksi6n4|…/ })` — a quick regex over the 23 suffixes). Fix any hits to the clean URLs.

**Verify:**
- [ ] All 23 clean URLs render (200) on the public site.
- [ ] `db.blogs.countDocuments({ slug: /-(mpksi6n4|mpc9jti5|…)$/ })` → 0.

## Phase 2 — Redirects: one self-contained, deletable file

1. Create `frontend/lib/blog-slug-redirects.mjs`:
   ```js
   // Legacy blog slugs (random-suffix era, pre-2026-07). One-time list — the
   // slug generator no longer produces suffixes. Safe to delete this file and
   // its single spread in next.config.mjs once these URLs stop receiving hits.
   export const blogSlugRedirects = [
     { old: 'migmaai-now-works-inside-whatsapp-telegram-discord-and-slack-mpksi6n4', clean: 'migmaai-now-works-inside-whatsapp-telegram-discord-and-slack' },
     // … all 23 pairs from the request mapping …
   ].map(({ old, clean }) => ({
     source: `/blog/${old}`,
     destination: `/blog/${clean}`,
     permanent: true,
   }))
   ```
2. In `next.config.mjs`: `import { blogSlugRedirects } from './lib/blog-slug-redirects.mjs'` and append `...blogSlugRedirects` at the end of the array returned by the existing `redirects()`.

**Deletability:** removing the feature later = delete one file + one spread line. (Recommendation: never delete it — it costs nothing and backlinks live forever. But the structure makes it a one-line decision.)

**Performance:** build-time manifest entries; zero effect on page load, bundle size, or unrelated routes. No middleware, no runtime lookup.

**Verify:**
- [ ] `curl -sI https://migma.ai/blog/migmaai-now-works-inside-whatsapp-telegram-discord-and-slack-mpksi6n4` → `308` + `location: /blog/migmaai-now-works-inside-whatsapp-telegram-discord-and-slack` (spot-check 3–4; script-loop all 23).
- [ ] Redirect target returns 200 (no chains, no loops).
- [ ] A control URL (`/blog/some-nonexistent-post`) still 404s — no over-matching.

## Phase 3 — SEO hygiene (15 minutes, after deploy)

1. Confirm `app/sitemap.ts` output now lists only clean URLs (it reads live slugs — should be automatic).
2. Resubmit the sitemap in Google Search Console; optionally use URL Inspection on the top 2–3 posts to nudge recrawl.
3. Grep both repos for hardcoded old URLs (nav, footers, social-post templates): `grep -rn "mpksi6n4\|mpc9jti5\|mpamanbt\|…" frontend backend` → fix any hits. (Initial spot-check found none in frontend code.)
4. Update any off-site links you control (Discord pins, X/LinkedIn bios, email footers) — optional, redirects cover them regardless.

## Guards
- **Order matters:** ship the DB slug rename and the redirects in the same deploy (or slugs first, redirects minutes later). Redirects-first would 308 users to 404s.
- Don't add a catch-all regex redirect for `-[a-z0-9]{8}$` — false-positive risk on legitimate slugs, and the pattern is extinct.
- Don't edit `app/sitemap.ts` or the `[id]` page — nothing there keys off the suffix.
- `permanent: true` responses are cached hard by browsers — double-check each `destination` string against the mapping before deploy; a typo'd permanent redirect is annoying to un-cache.

## Effort estimate
~1–2 hours including verification. Phase 1 script ≈ 40 min, Phase 2 ≈ 20 min, verification + Search Console ≈ 30 min.
