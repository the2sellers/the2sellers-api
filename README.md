# The2Sellers.io — FBA Marketplace API + Admin Panel

Backend for the FBA business listings marketplace: public submission endpoints,
a team review/publish workflow, and public browse endpoints for buyers.

## What's included

- `server.js` — the Express API
- `db.js` — database connection and schema (PostgreSQL)
- `auth.js` — login, JWT tokens, role-based access (admin vs reviewer)
- `seed-admin.js` — script to create team login accounts
- `admin/` — the admin panel (login, listing queue, review/publish screen, buyer inquiries)

## Why Postgres, and why this matters for free hosting

This runs on Render's free tier, which does **not** keep a local database file safe —
the app's local storage resets whenever it restarts (which happens often on the free
tier, including every time it wakes up from sleeping). Using a real, separately-hosted
Postgres database means your data survives that completely. **Neon** (neon.tech) has a
genuinely free-forever tier that's a good fit here.

## Running it locally

You need a Postgres database to point at. Two options:

**Option A — use a free Neon database even for local testing** (simplest, no local install):
1. Sign up at neon.tech, create a project, copy the connection string it gives you.
2. Create a file named `.env` in this folder with:
   ```
   DATABASE_URL=<paste your Neon connection string here>
   JWT_SECRET=<any long random string>
   ```

**Option B — run Postgres locally** if you have it installed, and set `DATABASE_URL`
to point at that instead.

Then:

```bash
npm install
node seed-admin.js "Your Name" "you@the2sellers.io" "a-real-password" "admin"
node server.js
```

Open `http://localhost:4000/admin/login.html` in a browser.

- Use `"admin"` as the last argument for team members who should be able to delete listings.
- Use `"reviewer"` for team members who should review/edit/publish but not delete.
- Run `seed-admin.js` again with different details to add more team members.
- The database tables are created automatically the first time the server starts — no manual setup needed beyond having a `DATABASE_URL`.

## Deploying (Render + Neon, both free)

1. Create a free Neon project, copy its connection string.
2. On Render, create a new Web Service from this repository.
3. In Render's Environment settings, add:
   - `DATABASE_URL` = your Neon connection string
   - `JWT_SECRET` = a long random string
4. Render will run `npm install` and then `node server.js` automatically.
5. Once live, run `seed-admin.js` once (Render's dashboard has a "Shell" tab for this) to create your first team login.

## API endpoints

**Public (used by the website's forms):**
- `POST /api/listings` — sell form submission
- `POST /api/buyer-inquiries` — buy form submission
- `GET /api/public/listings` — browsable published listings (optional `?niche=` and `?marketplace=` filters)
- `GET /api/public/listings/:id` — a single published listing's detail page

**Admin (require login):**
- `POST /api/admin/login`
- `GET /api/admin/listings` (optional `?status=pending|in_review|published|rejected|archived`)
- `GET /api/admin/listings/:id`
- `PATCH /api/admin/listings/:id` — edit public copy, change status, add internal notes
- `DELETE /api/admin/listings/:id` — admin role only
- `GET /api/admin/buyer-inquiries`

## Before this goes live

1. **Set a real `JWT_SECRET`** on Render — don't reuse any test value.
2. **Update `API_BASE`** in three website files once deployed — `buy-sell-fba.html`, `browse-fba.html`, and `fba-listing.html` each currently point at `http://localhost:4000/api` for testing. Change all three to the real Render URL.

## What's already tested

Full submit → review → publish → public-visibility workflow, role-based permissions
(reviewer vs admin), auth guards on every protected route and page, confirmed that
seller contact details never leak into public API responses — all re-verified against
a real Postgres database, not just the earlier local-file version.

Also tested: the actual website forms (`buy-sell-fba.html`) submitting through a real
browser and landing correctly in the database, the admin panel's full login → review →
publish flow through a real browser, and the public browse/detail pages correctly
showing only published listings.
