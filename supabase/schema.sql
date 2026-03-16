-- =============================================================================
-- No Cap Fund — Representatives Table
-- Run this once in: Supabase Dashboard → SQL Editor
-- =============================================================================

CREATE TABLE IF NOT EXISTS representatives (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bioguide_id   TEXT        UNIQUE NOT NULL,          -- e.g. 'L000591'
  name          TEXT        NOT NULL,                  -- e.g. 'Ted Lieu'
  party         TEXT        NOT NULL,                  -- 'Democrat' | 'Republican' | 'Independent'
  state         TEXT        NOT NULL,                  -- 2-letter abbr, e.g. 'CA'
  district      INTEGER     NOT NULL,                  -- 0 = at-large (AK, WY, etc.)
  phone         TEXT,                                  -- e.g. '202-225-3976'
  website       TEXT,                                  -- e.g. 'https://lieu.house.gov'
  no_cap_pledge BOOLEAN     NOT NULL DEFAULT FALSE,    -- ← flip to TRUE when they sign
  stance_notes  TEXT,                                  -- optional quote or position summary
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique index so lookups by state + district are fast and unambiguous.
-- Each district has exactly one representative at any given time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_rep_state_district
  ON representatives (state, district);

-- =============================================================================
-- Row Level Security
-- Public: anyone can read. Only the service role can write.
-- The anon key (used in the frontend) is safe to expose because of these rules.
-- =============================================================================

ALTER TABLE representatives ENABLE ROW LEVEL SECURITY;

-- Allow the public (anon key) to SELECT all rows — the map is public.
CREATE POLICY "Public read access"
  ON representatives
  FOR SELECT
  USING (true);

-- No INSERT / UPDATE / DELETE policy for anon — blocked by default.
-- To update pledge status: use Supabase Dashboard → Table Editor,
-- or build an admin page that authenticates with Supabase Auth.

-- =============================================================================
-- Auto-update updated_at on any row change (useful for tracking pledge updates)
-- =============================================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER set_updated_at
  BEFORE UPDATE ON representatives
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- =============================================================================
-- Updating pledge status (no admin UI needed for small updates):
--
--   UPDATE representatives
--   SET    no_cap_pledge = TRUE,
--          stance_notes  = 'Proud to support the No Cap Act. — Rep. Jane Doe, 2025-03-01'
--   WHERE  bioguide_id   = 'D000123';
--
-- Run that in the SQL Editor whenever a rep signs.
-- =============================================================================
