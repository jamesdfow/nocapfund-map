# No Cap Fund – Congressional District Map

An interactive map tracking which members of the U.S. House of Representatives have signed the No Cap Fund pledge to increase representation in Congress.

## What it does

- **Click any district** on the map to see who represents it, their party affiliation, and whether they have signed the No Cap pledge
- **Search by address or zip code** to find your district and representative
- **Contact information** — phone number and official website are shown for every rep so you can reach out directly

## Tech stack

- [Leaflet.js](https://leafletjs.com/) — interactive map
- [U.S. Census TIGER API](https://tigerweb.geo.census.gov/) — congressional district boundaries (119th Congress)
- [Supabase](https://supabase.com/) — database storing representative data and pledge status
- Hosted on [Netlify](https://netlify.com/)

## Updating pledge status

When a representative signs the No Cap pledge, update their record in the Supabase SQL Editor:

```sql
UPDATE representatives
SET    no_cap_pledge = TRUE,
       stance_notes  = '"Quote from the rep." — Rep. Name, YYYY-MM-DD'
WHERE  bioguide_id   = 'XXXXXXX';
```

Look up a rep's `bioguide_id` in the Supabase Table Editor by searching their name.

## Local development

No build process — open `index.html` directly or use a local server (e.g. VS Code Live Server).

To re-seed the representative database:

```bash
SUPABASE_URL=https://your-project.supabase.co \
SUPABASE_SERVICE_KEY=your-service-role-key \
node scripts/seed-representatives.js
```

Requires Node 18+.
