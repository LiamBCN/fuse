# PLAN: Author Location (Country + City)

**Repos:**
- Frontend: `/Users/liam/migma-both/frontend` (Next.js App Router, admin at `app/(admin)/admin/blog/`, public blog at `app/(public)/blog/`) — pinned `22aaf305`
- Backend: `/Users/liam/migma-both/backend` (Express + Mongo, authors at `src/routes/author.ts`) — pinned `57332c2`

**Task (verbatim benchmark prompt):**
> Make a plan where we, in the admin panel inside the blog administration page. We need to add for author dialog when user is adding a new author a country and city inputs. After that, we need to show that in the author public page and articles published by the author.

**Scope:**
1. Add two **optional** author fields — `city` and `country` (separate strings, not one combined "location").
2. Persist them safely through the **existing** author create/update endpoints (no new routes, no migration).
3. Add **City** and **Country** inputs to the author dialog inside the **blog administration page** (the primary surface named in the prompt), plus the standalone Authors admin page for parity.
4. Show a formatted location on the **public author page** and on **public article surfaces** that display author details.
5. Extend Person/Article structured data and public-page revalidation conservatively.

**Non-goals:** requiring the fields, backfilling existing authors, new endpoints, a geo/autocomplete service, per-article location overrides.

---

## Phase 0 — Ground Truth (verified in code; do NOT re-derive)

### Existing building blocks (use these)

| Capability | Location | Notes |
|---|---|---|
| Backend `Author` type | `backend/src/types/author.ts:3-17` | Fields: `slug?, name (req), avatar?, bio?, credentials?, role?, email (req), sameAs?, knowsAbout?, isDefault?, createdAt, updatedAt`. Mongo is schemaless — new optional fields need no migration. |
| Author create/update request types | `backend/src/types/author.ts` (`AuthorCreateRequest`, `AuthorUpdateRequest`) | Mirror these when adding `city`/`country`. |
| Author routes | `backend/src/routes/author.ts:89-118` | `POST /` + `PUT /:id` guarded by `authenticate()` + `requireAdminPanel('blog')` and `validateRequest(createAuthorSchema|updateAuthorSchema)`. Public reads: `GET /`, `GET /slug/:slug`, `GET /:id`. |
| Zod validation | `backend/src/routes/author.ts:9-30` | `createAuthorSchema` / `updateAuthorSchema` — **explicit allowlist**; anything not listed is dropped before it reaches the service. |
| Service persistence | `backend/src/services/author.service.ts` — `createAuthor()` ~`80-111`, `updateAuthor()` ~`153-181` | **Second explicit allowlist**: create builds an object field-by-field; update copies only `if (updateData.X !== undefined)`. Both must be edited or the field never persists. |
| Article→author link | `backend/src/types/blog.ts:16-17` (`authorEmail` req, `authorId?`) + `BlogWithAuthor.author?` (`:39`) | Author is **populated on read**, not embedded. |
| Author population on public reads | `backend/src/services/blog.service.ts` — `findBlogWithAuthor()` ~`1091`, `findBlogsWithAuthors()` ~`1135` | Public blog detail + list already return the **full** author object → new fields flow to the frontend automatically once persisted. No read-path change needed. |
| Frontend `Author` type | `frontend/types/author.ts:1-15` + `CreateAuthorRequest` `28-38` / `UpdateAuthorRequest` `40-49` | Add `city?`, `country?` here. |
| Author API client | `frontend/lib/services/author-service.ts:88-98` | Generic `createAuthor` / `updateAuthor` post the request body as-is → **no client change needed**; admin writes already go through this (no raw fetch). |
| **Author dialog in blog admin (primary target)** | `frontend/app/(admin)/admin/blog/page.tsx` | State `authorFormData` `:117-125`; edit hydration `:200-211`; submit `handleAuthorSubmit` `:223-275` (updateData `235-243`, createData `251-259`); dialog JSX + title "Add New Author"/"Edit Author" `:845`; `resetAuthorForm()` clears state (called `:269`). |
| Author dialog in standalone Authors page (parity target) | `frontend/app/(admin)/admin/authors/page.tsx:30-36` (state), `86-95` (hydrate), `164-169`/`147-152` (submit), `376-459` (inputs) | Simpler form (name/avatar/bio/role). Apply the same two fields for consistency. |
| Public author page | `frontend/app/(public)/blog/author/[slug]/page.tsx` | Fetch `:85-87`; profile render `:127-169` (role `:134`, bio/credentials `:136`); Person + ProfilePage JSON-LD `:92-115`; slug fallback `:45-46`. |
| Public article detail | `frontend/app/(public)/blog/[id]/page.tsx` | Author byline block `:565-615`; author Person JSON-LD `:218-229`; metadata/OG `:313-419`. |
| Article cards / list | `frontend/app/(public)/blog/components/blog-list.tsx:104-162` | Shows author avatar + name (`:134-147`) — candidate for a compact location line. |
| Country data | `frontend/lib/utils/countries-languages.ts:1-50` | Existing ISO country list + alias normalization (`USA`→`US`, …). Reuse for the Country input and for schema `addressCountry`. |
| Author create/update revalidation (already present) | `frontend/app/(admin)/admin/blog/page.tsx:214-221` (`revalidatePublishedBlogPages`, called `:248`,`:264`) | Revalidates **published article** pages on author save — but **not** the author profile page. |
| Author delete revalidation (pattern to mirror) | `frontend/app/(admin)/admin/blog/page.tsx:292-302` → `frontend/app/api/revalidate-blog/route.ts:93-101` | Delete flow already POSTs `authorSlug` so `/blog/author/[slug]` is revalidated. Reuse this path for save. |

### Anti-patterns / landmines (do NOT do these)

- **Do not** store a single combined `location` string — the prompt and checklist want **separate** `city` + `country`.
- **Do not** add a Mongo migration or backfill. Fields are optional; existing authors simply have them `undefined`.
- **Do not** make either field required, or block save/publish when they're empty (existing authors and the protected "Migma Team" default author have neither).
- **Do not** add a new author-location endpoint or a new public author fetch path — the existing create/update + populated-author reads are sufficient.
- **Do not** edit only the Zod schema **or** only the service allowlist — a field must be added in **both** the schema *and* the service, or it silently vanishes.
- **Do not** render blank rows, a lone comma, or a dangling separator when one/both fields are empty. Every public surface must go through the formatter (below) and render nothing when it returns empty.
- **Do not** touch `blog.authorEmail` semantics — it's the existing creator/login linkage, unrelated to display location.

---

## Phase 1 — Backend: types, validation, persistence

**1a. Types** — `backend/src/types/author.ts`
Add to `Author`, `AuthorCreateRequest`, and `AuthorUpdateRequest`:
```ts
city?: string;
country?: string;
```

**1b. Validation** — `backend/src/routes/author.ts` (both `createAuthorSchema` and `updateAuthorSchema`):
```ts
city: z.string().max(100).optional().nullable(),
country: z.string().max(100).optional().nullable(),
```
(`.nullable()` matches the existing optional fields and lets the client send `null` to clear a value.)

**1c. Persistence** — `backend/src/services/author.service.ts`
- In `createAuthor()`, add to the constructed document alongside `role`:
  ```ts
  city: safeAuthorData.city,
  country: safeAuthorData.country,
  ```
- In `updateAuthor()`, add clear-capable conditional copies (mirroring `avatar`/`role`):
  ```ts
  if (updateData.city !== undefined) safeUpdate.city = updateData.city ?? undefined;
  if (updateData.country !== undefined) safeUpdate.country = updateData.country ?? undefined;
  ```
No index or schema change required (schemaless Mongo). An index on `country` is explicitly out of scope.

---

## Phase 2 — Shared location formatter (single source of truth)

Create one small helper and use it **everywhere** location is displayed or serialized, so empty/partial values never produce dangling commas.

`frontend/lib/utils/author.ts` (new):
```ts
export function formatAuthorLocation(city?: string, country?: string): string {
  return [city?.trim(), country?.trim()].filter(Boolean).join(", ");
}
```
- `"Berlin", "Germany"` → `"Berlin, Germany"`
- `"", "Germany"` → `"Germany"`
- `"Berlin", ""` → `"Berlin"`
- both empty → `""` (callers render nothing)

---

## Phase 3 — Admin author dialog(s)

**3a. Blog administration page (primary — named in the prompt)** — `frontend/app/(admin)/admin/blog/page.tsx`
- `authorFormData` initial state (`:117-125`): add `city: '', country: ''`.
- `resetAuthorForm()`: include `city: '', country: ''` so a fresh "Add New Author" never inherits stale values.
- Edit hydration (`:200-211`): add `city: author.city || '', country: author.country || ''`.
- `handleAuthorSubmit` (`:223-275`): add `city: authorFormData.city || undefined` and `country: authorFormData.country || undefined` to **both** `updateData` (`:235-243`) and `createData` (`:251-259`).
- Dialog JSX (near `:845`): add a **City** text input and a **Country** input (a `<select>` sourced from `countries-languages.ts` is preferred for clean schema values; a plain text input is acceptable). Place them after Role. Both clearly optional (no required marker).

**3b. Standalone Authors page (parity)** — `frontend/app/(admin)/admin/authors/page.tsx`
Apply the same five edits (state `:30-36`, reset `:69-77`, hydrate `:86-95`, submit `:147-169`, inputs `:376-459`). Skipping this leaves the two dialogs inconsistent.

All writes continue through `AuthorService.create/updateAuthor` — no new client method, no raw fetch.

---

## Phase 4 — Public display

**4a. Author profile page** — `frontend/app/(public)/blog/author/[slug]/page.tsx`
In the profile block (`:127-169`), after role/credentials, render location only when present:
```tsx
{formatAuthorLocation(author.city, author.country) && (
  <p className="...">{formatAuthorLocation(author.city, author.country)}</p>
)}
```

**4b. Article detail byline** — `frontend/app/(public)/blog/[id]/page.tsx`
In "The author" block (`:565-615`), add the same guarded location line under the author name/role, reading from `blog.author?.city` / `blog.author?.country`.

**4c. Article cards / list (author is shown here)** — `frontend/app/(public)/blog/components/blog-list.tsx:134-147`
Optionally append a compact location beside the author name using the same formatter, guarded so cards without location are unchanged. Keep it subtle to avoid noisy repetition across a grid.

Because the backend already populates the full author object on public reads (Phase 0), no fetch/query changes are needed on any of these surfaces.

---

## Phase 5 — Structured data (only when location exists)

**5a. Author Person + ProfilePage JSON-LD** — `author/[slug]/page.tsx:92-115`
Add a conservative `address` only when a field is set:
```ts
...(author.city || author.country
  ? { address: { '@type': 'PostalAddress',
        ...(author.city && { addressLocality: author.city }),
        ...(author.country && { addressCountry: author.country }) } }
  : {}),
```
Reuse `countries-languages.ts` to emit an ISO code for `addressCountry` when available; otherwise the raw string is acceptable.

**5b. Article author Person JSON-LD** — `blog/[id]/page.tsx:218-229`
Add the identical conditional `address` to the article's author Person node. Do **not** add location to the `BlogPosting`/OG article tags — author location belongs on the Person, not the article.

---

## Phase 6 — Revalidation

Saving an author's city/country must refresh the **author profile page**, which today's save path does not do (`revalidatePublishedBlogPages` only hits published article pages, `:214-221`).

- Extend the create/update success path in `blog/page.tsx` to also revalidate `/blog/author/[slug]`, mirroring the delete flow (`:292-302`) that already POSTs `authorSlug` to `frontend/app/api/revalidate-blog/route.ts` (which calls `revalidatePath('/blog/author/${authorSlug}')`, `:93-101`).
- Compute the slug the same way the public page does (`author.slug || slugify(author.name)`, per `:45-46`).
- Article pages are already revalidated by the existing call, so bylines pick up the new location too. ISR (300s) would eventually refresh regardless; explicit revalidation makes it immediate.

---

## Phase 7 — Verification

**Backend**
- `POST /api/authors` with `{name, city, country}` persists both; response echoes them.
- `POST` with neither → author saved, fields `undefined` (no error).
- `PUT /:id` sets, changes, and **clears** (`null`) city/country independently.
- Fields absent from the schema are still stripped (allowlist intact); unrelated fields (email uniqueness, `isDefault`) unchanged.

**Admin UI**
- Blog-admin "Add New Author": City/Country inputs present, optional; submit sends them; new author shows location.
- Edit existing author: dialog hydrates city/country; save persists edits and clears when emptied.
- Reopen "Add New Author" after an edit → fields blank (reset works).
- Standalone Authors page mirrors the above.

**Public**
- Author page shows `City, Country` / city-only / country-only correctly; **nothing** (no stray comma) when both empty.
- Article detail byline shows the same; article cards (if changed) too.
- Existing authors with no location render exactly as before.
- View source: Person JSON-LD includes `address` only when set; `addressLocality`/`addressCountry` correct; no empty `address` node; `BlogPosting` unchanged.
- After editing location in admin, the public author page reflects it without waiting for full ISR expiry.

**Regression**
- Protected "Migma Team" default author still saves/edits with no location.
- `typecheck`/build clean on both repos.

---

## File-change summary

| Repo | File | Change |
|---|---|---|
| backend | `src/types/author.ts` | `city?`, `country?` on `Author` + create/update request types |
| backend | `src/routes/author.ts` | add fields to `createAuthorSchema` + `updateAuthorSchema` |
| backend | `src/services/author.service.ts` | persist in `createAuthor`; clear-capable copies in `updateAuthor` |
| frontend | `types/author.ts` | `city?`, `country?` on `Author` + create/update request types |
| frontend | `lib/utils/author.ts` *(new)* | `formatAuthorLocation()` |
| frontend | `app/(admin)/admin/blog/page.tsx` | state/reset/hydrate/submit + City/Country inputs + author-page revalidation |
| frontend | `app/(admin)/admin/authors/page.tsx` | same field wiring (parity) |
| frontend | `app/(public)/blog/author/[slug]/page.tsx` | render location + Person `address` |
| frontend | `app/(public)/blog/[id]/page.tsx` | byline location + author `address` |
| frontend | `app/(public)/blog/components/blog-list.tsx` | optional compact location on cards |
