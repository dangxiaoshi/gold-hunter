# TODOS

Items deferred from engineering review (2026-04-03).

---

## [ ] Server-side note/tag storage for contacts

**What:** Move contacts notes/tags from localStorage to customers.json DB via PATCH /api/customers/:id. Add `note` and `tags` fields to the allowed patch fields in server.js:169.

**Why:** localStorage is per-browser. Notes are the highest-value data in contacts.html — they should survive browser resets and be accessible if you ever run this from another browser.

**Pros:** Notes survive browser data clears, survive machine changes.

**Cons:** Needs DB schema change + PATCH update + contacts.html rewrite to use API instead of localStorage. ~30min.

**Context:** The current plan re-keys localStorage by id (fix for name collision bug). That's the right short-term fix. This is the proper long-term solution. Once server-side notes land, the localStorage re-key fix becomes a migration path rather than a permanent home.

**Depends on:** Architecture cache fix (Issue 2) should land first so PATCH doesn't hit disk on every keystroke.

---

## [ ] Audit and remove public/app.js

**What:** Read public/app.js (821 lines). Grep all HTML files for any reference to it. If it's truly unused, delete it. If it's referenced somewhere, document why.

**Why:** 821 lines of potentially dead code is confusing. All 5 pages are self-contained inline scripts. app.js may be a v1 artifact that was never cleaned up.

**Pros:** Cleaner codebase.

**Cons:** Low risk of breaking something if there's a dynamic import not visible from grep.

**How to check:**
```bash
grep -r "app.js" public/
```
If no results: safe to delete.

**Blocked by:** Nothing.
