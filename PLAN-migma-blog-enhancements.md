# PLAN: Migma Blog Admin Enhancements

**Repos:**
- Frontend: `/Users/liam/migma-both/frontend` (Next.js, admin at `app/(admin)/admin/blog/`)
- Backend: `/Users/liam/migma-both/backend` (Express, blog routes at `src/routes/blog.ts`, authors at `src/routes/author.ts`)

**Scope (6 requests):**
1. Visible "Open" button on author cards → public author profile
2. Per-article metrics (answer: they already exist — see Phase 0)
3. Author deletion restricted to full admins
4. AI cover image generation + article image references locked to `reference-bg-migma` only
5. Instagram second image: less text, AI-generated from an in-article image + `1.png`; add an "ending story" promoting the feature
6. Brand font (`MigmaAIDisplayTitle`) for titles in all generated images

---

## Phase 0 — Ground Truth (verified in code; do NOT re-derive)

### Allowed APIs / existing building blocks

| Capability | Location | Notes |
|---|---|---|
| Author cards + kebab menu | `frontend/app/(admin)/admin/blog/page.tsx:649–712` (menu trigger 683–685, menu items 687–701) | Edit + Delete (delete hidden for `isDefault`) |
| Public author profile route | `frontend/app/(public)/blog/author/[slug]/page.tsx` | Slug fallback: `author.slug \|\| slugifyPathSegment(author.name)` (lines 16–22, 53, 98) |
| Per-article views | `blog.views` (`backend/src/types/blog.ts:20`), badge on admin post cards (`page.tsx:490–493`), full **Metrics tab** (`blog-metrics-section.tsx`: date range, area chart, top posts) backed by `GET /api/blog/admin/metrics` + `blog_daily_views` collection | **Metrics already exist and are visible** |
| Author DELETE endpoint | `backend/src/routes/author.ts:110–115` — `authenticate()` + `requireAdminPanel('blog')` | Currently deletable by scoped roles `blog` / `blog-redesign` too |
| Full-admin middleware | `backend/src/middleware/auth.middleware.ts:139–144` — `AuthMiddleware.requireAdmin()` checks `isFullAdmin` | Exists; just not used on author DELETE |
| Frontend role info | `user.adminAccess: { role, sections, isFullAdmin }` (`frontend/types/auth.ts:33–91`), helpers in `frontend/lib/admin-access.ts` | `useAuth`-provided user in admin pages |
| AI cover generation | **Already shipped**: `BlogCoverImage` "Generate with AI" button (`frontend/components/blog/blog-cover-image.tsx:94–96`) → `handleGenerateOGImage` (`blog-editor-screen.tsx:857`) → `POST /api/blog/generate-og-image` (Gemini) → sets `formData.image` (the cover) | Request 4a is mostly verification/polish |
| OG/inline AI image endpoint | `backend/src/controllers/blog-og-image.controller.ts:46–134`; prompt builder 140–180; hardcoded refs `BRAND_REFERENCE_IMAGES` lines 13–16 (both from `reference-bg-migma`); SSRF guard on `referenceImageUrl` lines 84–93 | Gemini image-to-image when refs present |
| Reference images folder | `frontend/public/images/reference-bg-migma/` → `0.png`, `1.png`, `123123423.png`, `photoshop-3312.png`. `1.png` confirmed at `frontend/public/images/reference-bg-migma/1.png` | Brand picker list already in `ImageSourceDialog.tsx:11–16` (`BRAND_BACKGROUNDS`) |
| Non-brand reference sources (the "other source" to remove) | (a) editor inline-image "Inspiration reference" **device upload** (`frontend/components/blog/notion-editor/media-placeholder-view.tsx:36,90–100,320`) passes any uploaded URL as `referenceImageUrl`; (b) backend accepts **arbitrary** `referenceImageUrl` (only SSRF-guarded, not brand-restricted) | These are the sources to shut off |
| In-article image enumeration | `extractArticleImages()` `frontend/lib/utils/blog-social.ts:16–35` (markdown + `<img>` regex) | Reusable for Instagram flow |
| Instagram stories today | `InstagramStoryCard.tsx:18–73`: two canvas-rendered stories — Cover (title+CTA) and **Highlights (text-heavy bullets)** via `renderStoryBlob` (`social/story-image.ts:70–162`, font const line 14 = Inter). Manual download + `window.open('https://www.instagram.com/')`. **No Instagram API integration.** | "Second image" = the Highlights story |
| Gemini image gen | `GeminiService.generateImage(prompt, projectId, userId, imageUrls?, aspectRatio)` (`gemini.service.ts:1271+`); `AspectRatio` includes `'9:16'` (line 32); image-to-image model auto-selected when refs present (1321–1324) | 9:16 supported ✔ |
| Brand fonts | `MigmaAIDisplayTitle-Bold.woff2` + `-BoldItalic.woff2` in `frontend/public/fonts/`; `@font-face` in `frontend/app/globals.css:1–15`; body font Inter (`tailwind.config.ts:53`) | Not used in any image generation today |

### Anti-patterns / stale landmines (do NOT build on these)
- `backend/src/services/blog.service.ts:498` comment claims inline images use "OpenAI gpt-image-2" — **stale**. Inline/hero images in "Draft with AI" are SVG→sharp renders via `BlogThumbnailService` (no AI, no references). Do not plan around gpt-image-2.
- There is **no Instagram publishing API**; type `instagram-carousel` exists (`backend/src/types/social-post.ts`) but is unimplemented. Do not invent a publish endpoint — stories remain download-then-post-manually.
- `blog_daily_views` writes are fire-and-forget (`blog-metrics.service.ts:52–71`); don't make metrics reads depend on synchronous tracking.
- The email-driven blog tool (`design/tools/create-blog-article.ts:358–364`) passes `undefined` refs to Gemini — prompt-only. Leave as-is unless told otherwise.

---

## Phase 1 — "Open" button on author cards (frontend only)

**What:** In `frontend/app/(admin)/admin/blog/page.tsx`, inside each author card's `CardHeader` (lines 656–704), add a visible ghost icon button labeled/tooltipped "Open" immediately left of the kebab trigger (lines 683–685), linking to the public profile.

- URL: `/blog/author/${author.slug || slugifyPathSegment(author.name)}` — copy the exact fallback used by the public page (`app/(public)/blog/author/[slug]/page.tsx:16–22`). Import the same `slugifyPathSegment` helper the public page uses; do not write a new slugifier.
- Open in new tab (`<a target="_blank" rel="noopener noreferrer">` or `window.open`), icon `ExternalLink` from lucide (already the icon library), same sizing as kebab button: `variant="ghost" size="sm" className="h-8 w-8 p-0"`.
- Optional consistency: the posts-tab kebab already has "View Public Post" — mirror wording "Open profile" in a tooltip/aria-label.

**Verify:**
- [ ] Button visible on every author card, aligned with kebab.
- [ ] Click on an author *with* a slug and one *without* a slug (name-fallback) both land on a working public profile.
- [ ] `npm run build` (frontend) passes.

**Guards:** don't construct URLs with `siteConfig.url` prefix (relative path is enough inside the same app); don't add the button inside the DropdownMenu (requirement is a *visible* button).

## Phase 2 — Author deletion: full admins only

**Backend** (`backend/src/routes/author.ts:110–115`): swap `AuthMiddleware.requireAdminPanel('blog')` → `AuthMiddleware.requireAdmin()` on the DELETE route only. POST/PUT stay blog-scoped. Copy middleware chain style from the POST route (lines 95–100).

**Frontend** (`frontend/app/(admin)/admin/blog/page.tsx`): gate the Delete menu item (line 692–699) with the current user: render only when `getAdminAccess(user).isFullAdmin` (helper in `lib/admin-access.ts:23–25`) in addition to the existing `!author.isDefault` check. Get `user` from the same auth context the admin layout uses (`app/(admin)/layout.tsx`).

**Verify:**
- [ ] As a `blog`-role user (seed/JWT with `adminPanel.role='blog'`): DELETE `/api/authors/:id` returns 403; Delete item absent in UI; Edit still works.
- [ ] As full admin: delete works, articles reassigned to Migma Team (existing toast shows `reassignedCount`).
- [ ] Backend tests/typecheck pass.

**Guards:** do not hide the whole kebab for scoped roles (Edit must remain); do not rely on frontend gating alone — the backend swap is the security boundary.

## Phase 3 — Article metrics (answer + small surfacing wins)

**Answer to the question:** Yes — metrics exist end-to-end: per-article all-time `views` (badge on each admin post card, `page.tsx:490–493`) and a dedicated **Metrics tab** (total views, posts published, daily area chart, top posts, date-range picker) backed by `GET /api/blog/admin/metrics`. Nothing needs building to "have" metrics.

**Optional polish (small, do only if desired):**
- Add a "Sort by views" option to the posts tab filter row (`page.tsx:414–423`); client-side sort on `blog.views ?? 0`.
- Show `views` in the blog editor header for the article being edited (data already on the fetched blog object).
- (Larger, defer unless asked) per-author aggregate views: sum `views` of that author's posts client-side from the already-fetched `blogs` list and show on author cards.

**Verify:** [ ] views badge renders `0` (not blank) for new posts; [ ] sort order matches badge numbers.

**Guards:** don't add new backend metrics endpoints — aggregate client-side from data already fetched (`fetchBlogs()` pulls up to 100 posts with `views`).

## Phase 4 — AI cover image + reference lock-down to `reference-bg-migma`

### 4a. Cover generation (mostly exists — verify & polish)
"Generate with AI" already exists on the cover component (`blog-cover-image.tsx:94–96` → `handleGenerateOGImage` → sets `formData.image`). Work:
- Manually verify it works end-to-end in the editor (needs `GEMINI` key configured in backend env).
- Polish: pass `subtitle` (already done) and consider passing `category`/`tags` into the prompt via the existing `prompt` param — copy the call shape from `handleEditorGenerateImage` (`blog-editor-screen.tsx:917–935`). No new endpoint.

### 4b. Restrict generation references to `reference-bg-migma` only
The generation endpoint currently accepts **any** `referenceImageUrl` (user device uploads via the inline-image "Inspiration reference" flow). Lock down:

1. **Shared brand-reference module (frontend):** create `frontend/lib/brand-references.ts` exporting the 4 paths currently duplicated in `ImageSourceDialog.tsx:11–16`; refactor `ImageSourceDialog` to import it.
2. **Editor inline generation** (`components/blog/notion-editor/media-placeholder-view.tsx`): replace the device-file "Inspiration reference" upload (lines 36, 90–100, 251–262, 320) with a small picker of the 4 brand backgrounds (thumbnails, single-select) reusing the shared module. Same for the regenerate flow in `blog-image-view.tsx:261–262` if it exposes reference selection.
3. **Backend whitelist** (`blog-og-image.controller.ts`): change the API contract from free-form `referenceImageUrl` to a `referenceKey` enum (e.g. `'0' | '1' | 'dark' | 'orange'`) resolved server-side to the known `reference-bg-migma` URLs (extend the existing `BRAND_REFERENCE_IMAGES` map, lines 13–16, to include `0.png` and `1.png`). Keep the SSRF guard for defense in depth but reject any raw URL not in the map. Update `frontend/lib/services/blog-service.ts` `generateOGImage` typing accordingly.
4. Default behavior unchanged: when no key is passed, the controller keeps using its two default brand refs (already `reference-bg-migma` files).

**Verify:**
- [ ] `grep -rn "referenceImageUrl" frontend backend` → only whitelist-resolved usage remains (or param renamed `referenceKey`).
- [ ] Inline image generation UI offers only the 4 brand backgrounds; no file upload for references.
- [ ] API call with a raw external URL returns 400.
- [ ] Cover + inline generation still produce images.

**Guards:** don't remove `FileUpload` for *content* images (uploading an image INTO the article stays); only the *generation reference* source is restricted. Don't touch the email-driven design tool path.

## Phase 5 — Instagram story revamp (second image + ending story)

Current "second image" (Highlights story) is a text-heavy canvas render (`renderStoryBlob`, `social/story-image.ts:70–162`, bullets from `extractArticleHighlights`, `blog-social.ts:41–66`). Replace with an AI-composed visual story, plus add a third "ending" story.

1. **Backend endpoint:** `POST /api/blog/:id/generate-story-image` in `src/routes/blog.ts`, guarded `authenticate() + requireAdminPanel('blog')` (copy chain from `/admin/metrics` route, `blog.ts:213–218`). Body: `{ kind: 'visual' | 'ending', articleImageUrl?: string }`.
   - `kind='visual'`: call `GeminiService.getInstance().generateImage(prompt, projectId, userId, [articleImageUrl, ONE_PNG_URL], '9:16')` where `ONE_PNG_URL` is the server-side constant for `reference-bg-migma/1.png` (add to the `BRAND_REFERENCE_IMAGES` map per Phase 4b). Prompt: 9:16 Instagram story, minimal text (a short 3–6 word hook at most), visually led by the article image's subject, brand gradient style — copy prompt scaffolding from `buildOGImagePrompt` (`blog-og-image.controller.ts:140–180`).
   - `kind='ending'`: references `[ONE_PNG_URL]` only; prompt: closing story slide inviting viewers to try the feature ("Read the full article — link in bio" + Migma feature CTA), minimal text.
   - Validate `articleImageUrl` is one of the article's own images server-side: fetch the blog by `:id` and check the URL appears in `blog.image` or `blog.content` (reuse the same regexes as `extractArticleImages` — port that function to a small backend util, source shape at `frontend/lib/utils/blog-social.ts:16–35`).
2. **Frontend picker for the "important" article image:** in `InstagramStoryCard.tsx`, list `extractArticleImages(blog)` results (already available — `ImageSourceDialog` gets `articleImages` today) and let the admin pick which in-article image mattered; default to the first inline (non-cover) image, falling back to `blog.image`.
3. **Replace the Highlights story:** swap its generation to call the new endpoint (`kind='visual'`), show a loading state, and keep the existing download button flow (`${filenameBase}.png`). Keep at most one short text overlay line, composited client-side with the brand font (see Phase 6) — do NOT ask Gemini to render paragraphs of text.
4. **Add the ending story card:** third card in `InstagramStoryCard.tsx` (copy the card structure of the existing two, lines 18–73) using `kind='ending'`, with its own download button.
5. Keep everything download-based; do not add any Instagram API/publishing code (none exists).

**Verify:**
- [ ] Generated story PNGs are 9:16 and visibly derived from the chosen article image + `1.png` styling.
- [ ] Text on the visual story is ≤ 1 short line; bullets/"What's inside" list is gone from the second story.
- [ ] Ending story generates with feature CTA and downloads.
- [ ] Endpoint 403s for non-admin-panel users; 400s for an `articleImageUrl` not present in the article.

**Guards:** Gemini text rendering is unreliable — never rely on it for exact wording; composite exact text client-side. Don't reuse the arbitrary-URL reference path (violates Phase 4b); the article-image exception is enforced server-side against the article's own content.

## Phase 6 — Brand font on generated titles

Font: `MigmaAIDisplayTitle` (`frontend/public/fonts/MigmaAIDisplayTitle-Bold.woff2`, `@font-face` in `app/globals.css:1–15`).

1. **Canvas story renderer** (`social/story-image.ts`): before drawing, `await document.fonts.load("700 96px MigmaAIDisplayTitle")` (the face is already declared globally, admin shares the root layout); change the heading/`title` draw calls (lines ~104–118) to `700 <size>px "MigmaAIDisplayTitle", Inter, sans-serif`. Body/bullet text stays Inter.
2. **Backend SVG thumbnails** (`blog-thumbnail.service.ts`, font-family attrs at lines 81/86/125): librsvg (sharp's SVG rasterizer) cannot load woff2 from CSS reliably. Convert `MigmaAIDisplayTitle-Bold.woff2` → TTF (e.g. `fonttools`/`woff2_decompress`), commit to `backend/src/assets/fonts/`, and register it for rendering — preferred: ship a minimal `fonts.conf` + set `FONTCONFIG_PATH`/`FONTCONFIG_FILE` at service start so `font-family="MigmaAIDisplayTitle"` resolves in sharp. **Spike first** (render one SVG with the font and assert non-fallback glyphs); if librsvg font pickup proves flaky in deployment, fall back to compositing the headline with `@napi-rs/canvas`-style text layer or accept Inter for backend thumbnails and note it.
3. **AI-generated images (covers, stories):** don't ask Gemini for a specific font. Exact-title text is composited after generation with the real font — client-side canvas for stories (step 1 machinery), or backend sharp overlay if server-side is ever needed.

**Verify:**
- [ ] Story PNG titles visually match the site's display font (compare with an `<h1>` on the public blog).
- [ ] Backend thumbnail spike renders MigmaAIDisplayTitle (screenshot/diff vs Inter render).
- [ ] No layout overflow: the display font is wider — re-check the canvas line-wrap width math in `renderStoryBlob`.

**Guards:** never claim the AI model rendered the brand font; woff2 inside SVG for librsvg is a known dead end — go TTF+fontconfig or composite.

## Phase 7 — Final verification

1. `npm run build` / typecheck in **both** repos; backend test suite.
2. Grep sweeps: `referenceImageUrl` (should be whitelisted/renamed), `requireAdminPanel('blog')` on author DELETE (should be gone), `Inter` in story-image.ts heading draws (title should use MigmaAIDisplayTitle).
3. Manual pass in admin: author Open button → public profile; delete gating per role; cover Generate with AI; inline image generation (brand refs only); full Instagram kit for one published article (cover story, visual story from article image + 1.png, ending story) — download all three and eyeball 9:16, minimal text, brand font titles.
4. Public site regression: blog post page renders, view tracking still fires (`POST /api/blog/:id/view`), author profile pages build (`generateStaticParams`).

---

## Open questions for Liam (non-blocking; defaults chosen)
1. **"Other source" for references** — I identified the device-upload "Inspiration reference" in the inline image generator (plus the API accepting arbitrary URLs) as the source to remove. If you meant something else (e.g. the email-canvas images in the design tool), say so — that path currently passes *no* image refs to Gemini anyway.
2. **Metrics** — they already exist (views badge + Metrics tab). Want the optional polish items in Phase 3 (sort-by-views, per-author totals), or skip?
3. **Ending story wording** — default CTA promotes reading the article + Migma's AI blog feature ("link in bio"). Provide exact copy if you have preferred wording.
