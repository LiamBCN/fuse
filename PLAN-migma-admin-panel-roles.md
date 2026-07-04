# Plan: Role-Based Admin Panel Access for the Migma Team

**Repos affected:** `MigmaAI/migma-backend` (Express API) and `AdamSEY/migma` (Next.js frontend).
All file paths below are relative to each repo's root. Line numbers reflect the current `main` (cloned 2026-07-02).

---

## 1. Goal

Let internal Migma team members access the admin panel with **scoped roles**:

| Role | Access |
|---|---|
| **Admin** | Entire admin panel, including managing team members |
| **Blog Editor** | Only the Blog page (`/admin/blog`) — draft, edit, publish articles (incl. authors + AI generation + image upload) |
| **Blog + Redesign** | Blog page **and** the Redesign Pipeline (`/admin/redesign-pipeline`) — nothing else |

Plus:
- An **"Admin Panel"** entry in the user profile dropdown, visible to anyone with any admin role, that lands them on the right page for their role.
- A **Team section inside the admin panel** where only full admins can add members, choose their role, change it, or revoke access.

> ⚠️ **Assumption to confirm:** the voice note said the third role covers "the flood page and the redesign engine". No page named anything like "flood"/"flow" exists in either repo — the admin pages are: Dashboard, Investor Dashboard, Attribution, Blog & Authors, Media, Competitors, Redesign Pipeline, User Outreach, Social Studio, User Management, WAF Blocks, API Logs, Sending, Background Tasks. I'm treating "flood" as a transcription of "**blog**", so role 3 = Blog + Redesign Pipeline. The design makes role→pages a one-line config, so correcting this later is trivial (§4).

---

## 2. What exists today (verified against code)

### Backend (`migma-backend`)

- **Auth:** JWT (30-day expiry, `auth.service.ts:95`) with payload `{ userId, email, role, subscriptionPlanType }` (`auth.service.ts:127-131`). `role` **is persisted on the User document** (`types/user.ts:94`, read at login `auth.service.ts:251,424,888`).
- **Every authenticated request already loads the fresh User document from Mongo** and caches it on the request: `authenticatedReq.userDocument = user` (`middleware/auth.middleware.ts:60`). This is the hook that makes instant grant/revoke possible without touching JWTs.
- **Admin gating is binary:** `AuthMiddleware.requireAdmin()` → `user.role !== 'admin'` → 403 (`auth.middleware.ts:138-148`). Note it reads the **JWT claim**, which can be up to 30 days stale.
- **Admin surface:**
  - `/admin-adam/*` — one big router (~75 endpoints: users, stats, KPIs, redesign-pipeline, outreach, competitors, seats…), gated once at router level (`routes/admin-adam.ts:71-72`), mounted at `routes/index.ts:201-204`. Redesign pipeline endpoints all live under `/admin-adam/redesign-pipeline*` (`admin-adam.ts:5355-5371`).
  - `/blog/*` and `/authors/*` — **separate routers, not under `/admin-adam`** (`routes/index.ts:85,87`). Reads are public; every write route (create/update/delete, `upload-image`, `generate*`) is individually wrapped with `authenticate() + requireAdmin()` (`routes/blog.ts:131-182`, `routes/author.ts:82-102`).
- **Profile endpoint:** `GET /api/user/profile` (`routes/api/user.ts:35-60`) returns the user (incl. `role`) and re-issues a fresh sliding-session token via `generateTokenForUser()`.
- **Existing org/workspace/seat system** (organizations, `organization-member` roles owner/admin/member, invitations, paid seats): this is the **customer-facing** collaboration system, entangled with Stripe seat billing that `ORG_SEATS_PROD_READINESS.md` marks **NO-GO** in several money paths (cancel never releases seats, wrong-org provisioning, non-atomic webhook dedup). **We deliberately do not build staff access on top of it** — see §3.

### Frontend (`migma`)

- **Admin guard is client-side only:** `app/(admin)/layout.tsx:16-36` (`AdminAuthGuard`) checks `user.role !== 'admin'` → redirect `/`. No `middleware.ts` route protection. (Fine — the backend is the real gate; the frontend guard is UX.)
- **Central admin nav:** `components/admin/admin-sidebar.tsx:121-251` — a single `navSections` array (Analytics / Content / Users / Sending / System) with labels + hrefs. Perfect place to filter per role.
- **User object:** `types/auth.ts:34` has `role?: string`; fetched from `/api/user/profile` on init (`lib/store/authStore.ts:117`), exposed via `useAuth()` (`contexts/AuthContext.tsx`).
- **Profile dropdown:** `components/user-profile.tsx` already has an "Admin Panel" item — but **mobile sheet only** (lines 621-630, gated on `role === 'admin'`), handler navigates to `/admin/dashboard` (lines 460-467). The desktop dropdown (~lines 1033-1087) has no admin entry.
- **Admin pages → API:** shared `apiClient` (`lib/services/api-client.ts`) with endpoints in `lib/config.ts`; admin pages hit `/api/admin-adam/*`, while the Blog admin page uses `BlogService`/`AuthorService` hitting `/api/blog/*` and `/api/authors/*` (`lib/config.ts:369-375`, `lib/services/blog-service.ts`, `lib/services/author-service.ts`).

---

## 3. Design decisions (and why)

1. **New dedicated field on the User document, not a reuse of `role`.**
   `role` is baked into every JWT and checked by unknown consumers in both repos; overloading it with new values (`'blog'`…) risks breaking `role === 'admin'` checks scattered around. Instead:
   ```ts
   // types/user.ts (backend)
   adminPanel?: {
     role: 'admin' | 'blog' | 'blog-redesign';
     grantedBy: string;   // userId of the admin who granted it
     grantedAt: Date;
   }
   ```
   Legacy `role === 'admin'` users are treated as full admins by the accessor (below) — **zero migration, zero regression** for existing admins.

2. **Roles are presets over page-sections, one source of truth in the backend.**
   ```ts
   // NEW src/types/admin-panel.ts (backend)
   export type AdminSection = 'blog' | 'redesign-pipeline' | /* future: 'media' | 'users' | ... */ ;
   export const ADMIN_ROLE_SECTIONS: Record<AdminPanelRole, AdminSection[] | ['*']> = {
     'admin':         ['*'],
     'blog':          ['blog'],
     'blog-redesign': ['blog', 'redesign-pipeline'],
   };
   export function resolveAdminAccess(user: User): { isFullAdmin: boolean; sections: AdminSection[] } {
     if (user.role === 'admin' || user.adminPanel?.role === 'admin') return { isFullAdmin: true, sections: ['*'] };
     return { isFullAdmin: false, sections: ADMIN_ROLE_SECTIONS[user.adminPanel?.role] ?? [] };
   }
   ```
   The computed `sections` are **returned in the profile response**, so the frontend never re-implements the mapping (no drift between repos). Adding a fourth role or changing role 3's pages later = editing this one map.

3. **Enforce on the server against the fresh DB document, not the JWT.**
   New middleware reads `req.userDocument` (already loaded on every request — no extra query). Revoking someone in the Team page locks them out on their **next request**, instead of after up to 30 days of JWT lifetime. JWT payload stays untouched.

4. **Deny-by-default for the big admin router.**
   `/admin-adam` has ~75 endpoints; mapping each to a section is error-prone and rots as endpoints are added. Instead: a path-prefix resolver where **only explicitly whitelisted prefixes are section-scoped, and everything unmapped requires full admin**. A future engineer adding `/admin-adam/new-thing` gets full-admin-only protection automatically — this is the "no future risk" property.

5. **Do not touch the customer org/seats/invitations system.**
   It's billing-entangled with known NO-GO money bugs (see §2). Staff access is a free, platform-level concern — a field on the user + an audit log. Also, team members must already have a Migma account; we **grant by email of an existing account** rather than building a parallel email-invitation flow (v1; see Open Questions).

---

## 4. Backend changes (`migma-backend`)

### Phase B1 — Access model + middleware (foundation, no visible change)

1. **`src/types/user.ts`** — add the `adminPanel` field (shape in §3.1).
2. **NEW `src/types/admin-panel.ts`** — `AdminPanelRole`, `AdminSection`, `ADMIN_ROLE_SECTIONS`, `resolveAdminAccess()` (§3.2).
3. **`src/middleware/auth.middleware.ts`** — add alongside the untouched `requireAdmin()`:
   ```ts
   static requireAdminPanel(section?: AdminSection) {
     return (req, res, next) => {
       const doc = (req as AuthenticatedRequest).userDocument;   // fresh DB state
       if (!doc) return ResponseHandler.forbidden(res, 'Admin privileges required');
       const access = resolveAdminAccess(doc);
       if (access.isFullAdmin) return next();
       if (section && access.sections.includes(section)) return next();
       return ResponseHandler.forbidden(res, 'Admin privileges required');
     };
   }
   ```
   `requireAdmin()` itself gains one change: read from `userDocument` (fall back to JWT claim) so full-admin checks also become revocation-fresh. Behavior for existing admins is identical.
4. **`src/routes/admin-adam.ts:71-72`** — replace the router-level `requireAdmin()` with a **section resolver** (deny-by-default):
   ```ts
   const SECTION_PREFIXES: Array<[string, AdminSection]> = [
     ['/redesign-pipeline', 'redesign-pipeline'],
     // unmapped paths ⇒ full admin required
   ];
   router.use(AuthMiddleware.authenticate());
   router.use((req, res, next) => {
     const match = SECTION_PREFIXES.find(([p]) => req.path === p || req.path.startsWith(p + '/'));
     return AuthMiddleware.requireAdminPanel(match?.[1])(req, res, next);
   });
   ```
5. **`src/routes/blog.ts` (lines 131-182) and `src/routes/author.ts` (lines 82-102)** — swap each `AuthMiddleware.requireAdmin()` on the write routes to `AuthMiddleware.requireAdminPanel('blog')`. This gives blog editors: create/edit/delete articles (drafts = `published: false`), author management, image upload, and the AI `generate*` endpoints. Public read routes stay public.
6. **`src/routes/api/user.ts` (profile handler, ~line 46-60)** — include in the response:
   ```ts
   adminAccess: { role, sections, isFullAdmin }   // from resolveAdminAccess(userDocument)
   ```

### Phase B2 — Team management API (full-admin only)

New router **`src/routes/admin-team.ts`**, mounted inside `/admin-adam` (so it inherits authenticate + falls under deny-by-default → full admin only):

| Endpoint | Behavior |
|---|---|
| `GET /admin-adam/team` | List members: users where `role === 'admin'` or `adminPanel` is set. Return id, email, name, effective role, grantedBy/At. |
| `POST /admin-adam/team` | Body `{ email, role }`. Look up **existing** user by email (case-insensitive); 404 with a clear "ask them to create a Migma account first" message if absent; set `adminPanel = { role, grantedBy: req.user.userId, grantedAt: new Date() }`. |
| `PATCH /admin-adam/team/:userId` | Change `adminPanel.role`. |
| `DELETE /admin-adam/team/:userId` | Unset `adminPanel` (revoke). |

**Safety guards (all server-side):**
- An admin cannot demote or remove **themself** (prevents accidental lockout mid-session).
- Cannot remove/demote the **last full admin** (count `role==='admin'` + `adminPanel.role==='admin'` before mutating).
- Legacy full admins (`role === 'admin'`) appear in the list but role changes for them only write `adminPanel` — never mutate the legacy `role` field (it feeds JWTs and unknown consumers).
- **Audit log:** append-only entries (who granted/changed/revoked what, when) — either a small new `admin_panel_events` collection modeled on the INSERT-only `seat-event.model.ts` pattern, or the existing `account-activity.model.ts` if it fits. Grants of admin access are exactly the kind of thing you want a paper trail for.
- Validate `role` against the enum with the existing `validate-request.middleware.ts` pattern.

---

## 5. Frontend changes (`migma`)

### Phase F1 — Consume the new access shape

1. **`types/auth.ts`** — add to `User`:
   ```ts
   adminAccess?: { role: 'admin' | 'blog' | 'blog-redesign'; sections: string[]; isFullAdmin: boolean }
   ```
   (Populated automatically once the profile endpoint returns it.)
2. **NEW `lib/admin-access.ts`** — tiny helpers, the only place the frontend reasons about admin access:
   ```ts
   hasAdminAccess(user)                  // any role
   canAccessSection(user, section)       // isFullAdmin || sections.includes(section)
   defaultAdminRoute(user)               // full admin → '/admin/dashboard'; else first section's page: blog → '/admin/blog', redesign-pipeline → '/admin/redesign-pipeline'
   PAGE_SECTIONS: Array<[pathPrefix, section]>  // '/admin/blog' → 'blog', '/admin/redesign-pipeline' → 'redesign-pipeline'; unmapped admin paths ⇒ full admin (mirrors backend deny-by-default)
   ```
3. **`app/(admin)/layout.tsx` (`AdminAuthGuard`, lines 16-36)** — replace `user.role !== 'admin'` with:
   - no `hasAdminAccess` → redirect `/` (as today);
   - has access but current `pathname` maps to a section they lack → redirect to `defaultAdminRoute(user)`.
   This covers deep links and in-panel navigation attempts. (It's UX only — the backend 403s are the actual security.)

### Phase F2 — Nav + profile dropdown

4. **`components/admin/admin-sidebar.tsx` (lines 121-251)** — tag each nav item with its section key (default: `'admin-only'`), then render `navSections` filtered through `canAccessSection`; drop empty section groups. Blog editors see just "Blog & Authors"; role 3 also sees "Redesign Pipeline".
5. **`components/user-profile.tsx`** —
   - change the mobile gate at line 621 from `user?.role === 'admin'` to `hasAdminAccess(user)`;
   - **add the same "Admin Panel" item to the desktop dropdown** (~lines 1033-1087) — today it exists only in the mobile sheet, and the request explicitly wants it in the profile dropdown menu;
   - `handleOpenAdminPanel` (lines 460-467): navigate to `defaultAdminRoute(user)` instead of hardcoded `/admin/dashboard` — this is the "redirected to the panel according to their role" behavior.
6. Grep both repos for any other `role === 'admin'` UI checks and route them through `hasAdminAccess` / `isFullAdmin` as appropriate.

### Phase F3 — Team management UI

7. **NEW `app/(admin)/admin/team/page.tsx`** + **`components/admin/team-management.tsx`** — visible to full admins only (sidebar item under a new "Team" entry in the System group, section key `'admin-only'`):
   - table of current members (email, name, role, granted by/at);
   - "Add member" dialog: email input + role select (Admin / Blog Editor / Blog + Redesign) with a one-line description of what each role can see;
   - per-row role change + revoke with confirm; self-row and last-admin actions disabled with a tooltip explaining why (mirrors the server guards).
8. **`lib/config.ts`** — add the four `/api/admin-adam/team` endpoints; reuse `apiClient`.

---

## 6. Security & future-proofing summary

- **Server is the authority.** Frontend guards/redirects are UX; every article write, redesign endpoint, and team mutation is enforced by `requireAdminPanel` against the fresh user document.
- **Instant revocation.** Enforcement reads `req.userDocument` (already fetched per request), never the 30-day JWT claim. No JWT schema change, no token invalidation machinery needed.
- **Deny-by-default.** Unmapped `/admin-adam/*` paths and unmapped `/admin/*` pages require full admin. New features are safe until someone deliberately opens them to a section.
- **Additive rollout, zero migration.** Existing admins keep working via the legacy `role === 'admin'` path; the new field is optional; each phase ships independently (B1 → B2 → F1-F3).
- **No entanglement with customer orgs/seats/Stripe** — avoids every NO-GO in `ORG_SEATS_PROD_READINESS.md`.
- **Auditability.** Append-only log of every grant/change/revoke, including the acting admin.
- Future options that slot in cleanly: more sections (`media`, `users`, `sending`…) = new enum values + prefix entries; custom per-user section sets; invitation emails for people without accounts; requiring 2FA (`auth-2fa.ts` exists) for any admin-panel member.

## 7. Testing plan

**Backend (`src/tests/`):**
- `resolveAdminAccess`: legacy `role==='admin'`, each preset role, no access, unknown role value.
- Route matrix per role — blog editor: `POST /blog` 200, `PATCH /admin-adam/redesign-pipeline/:id` 403, `GET /admin-adam/users` 403, `POST /admin-adam/team` 403; blog-redesign: blog 200 + redesign 200 + users 403; full admin: everything 200.
- Revocation freshness: revoke, then a request with the member's still-valid JWT → 403.
- Team guards: self-demotion 400, last-full-admin removal 400, unknown email 404, audit entry written per mutation.

**Frontend (manual + existing patterns):**
- Dropdown shows "Admin Panel" on **desktop and mobile** for each role, hidden with no role; landing page per role is correct.
- Blog editor deep-links to `/admin/users` → redirected to `/admin/blog`; sidebar shows only permitted items.
- Team page: add/change/revoke flows, disabled self/last-admin actions, error toasts for 4xx.

## 8. Open questions (answer whenever — defaults are safe)

1. **"Flood page" = Blog page?** Assumed yes (§1). If it's actually another page (Media? User Outreach?), it's a one-line change in `ADMIN_ROLE_SECTIONS` + one prefix entry.
2. **Grant-by-email of existing accounts is v1.** OK to require team members to sign up at migma.ai first? (Invitation emails are a clean later addition.)
3. **Role names** shown in the UI: "Admin", "Blog Editor", "Blog + Redesign" — rename freely; the stored keys are `admin` / `blog` / `blog-redesign`.
4. Should blog editors also get the **Media** page? v1 says no — the blog page's own `upload-image` endpoint covers article images.
