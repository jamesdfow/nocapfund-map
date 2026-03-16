#!/usr/bin/env node
/**
 * seed-representatives.js
 *
 * One-time script: pulls current House members from the unitedstates project
 * and upserts them into the Supabase `representatives` table.
 *
 * Usage (requires Node 18+ for native fetch):
 *
 *   SUPABASE_URL=https://xxxx.supabase.co \
 *   SUPABASE_SERVICE_KEY=eyJ... \
 *   node scripts/seed-representatives.js
 *
 * Get your service role key from:
 *   Supabase Dashboard → Project Settings → API → service_role key
 *
 * ⚠️  NEVER commit your service role key or deploy this script.
 *     It bypasses RLS — it's only for local admin use.
 */

'use strict';

const SUPABASE_URL    = process.env.SUPABASE_URL;
const SERVICE_KEY     = process.env.SUPABASE_SERVICE_KEY;
const LEGISLATORS_URL = 'https://unitedstates.github.io/congress-legislators/legislators-current.json';
const BATCH_SIZE      = 100;

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error(
      'Error: missing environment variables.\n' +
      'Set SUPABASE_URL and SUPABASE_SERVICE_KEY before running.\n\n' +
      'Example:\n' +
      '  SUPABASE_URL=https://xxxx.supabase.co \\\n' +
      '  SUPABASE_SERVICE_KEY=eyJ... \\\n' +
      '  node scripts/seed-representatives.js'
    );
    process.exit(1);
  }

  // ── Fetch source data ────────────────────────────────────────────────────────
  console.log('Fetching legislators-current.json …');
  const res       = await fetch(LEGISLATORS_URL);
  if (!res.ok) throw new Error(`Failed to fetch legislators: ${res.status}`);
  const all       = await res.json();

  // Keep only current House members (latest term type === 'rep').
  // Some legislators have mixed careers (rep → senator); latest term wins.
  const reps = all.filter(l => {
    const last = l.terms[l.terms.length - 1];
    return last?.type === 'rep';
  });

  console.log(`Found ${reps.length} current House members.`);

  // ── Map to DB rows ───────────────────────────────────────────────────────────
  const rows = reps.map(l => {
    const term = l.terms[l.terms.length - 1];
    return {
      bioguide_id:   l.id.bioguide,
      name:          l.name.official_full || `${l.name.first} ${l.name.last}`,
      party:         term.party   || 'Unknown',
      state:         term.state,
      district:      term.district ?? 0,   // null → 0 for at-large districts
      phone:         term.phone   || null,
      website:       term.url     || null,
      no_cap_pledge: false,
      stance_notes:  null,
    };
  });

  // ── Upsert in batches ────────────────────────────────────────────────────────
  // Prefer: resolution=merge-duplicates → re-running the script is safe.
  // Existing pledge status / stance_notes will be overwritten — run only once,
  // or remove those fields from the payload before re-running.
  console.log(`Upserting ${rows.length} rows in batches of ${BATCH_SIZE} …\n`);

  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    const response = await fetch(`${SUPABASE_URL}/rest/v1/representatives`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'apikey':         SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Prefer':        'resolution=merge-duplicates',
      },
      body: JSON.stringify(batch),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`  ✗ Batch ${i + 1}–${i + batch.length} failed:`, text);
    } else {
      inserted += batch.length;
      console.log(`  ✓ Rows ${i + 1}–${i + batch.length}`);
    }
  }

  console.log(`\nDone. ${inserted} / ${rows.length} rows inserted.`);
  console.log('\nNext steps:');
  console.log('  1. Verify in Supabase Dashboard → Table Editor → representatives');
  console.log('  2. Update pledge status via SQL Editor (see supabase/schema.sql for example)');
}

main().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
