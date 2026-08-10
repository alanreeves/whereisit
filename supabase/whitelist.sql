-- =============================================================================
-- Where Is It? — Email Whitelist
-- =============================================================================
-- Run this in: Supabase Dashboard → SQL Editor → New Query → Run
-- Run AFTER schema.sql.
--
-- This adds:
--   1. whitelist table   — authorised email addresses
--   2. check_whitelist() — RPC function called by the app before sign-up
-- =============================================================================

-- ─── Whitelist table ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.whitelist (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text        NOT NULL,
  full_name  text,
  notes      text,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT whitelist_email_unique UNIQUE (lower(email))
);

-- RLS on, no policies — invisible to all browser clients.
-- Managed exclusively via the Supabase SQL Editor (you).
ALTER TABLE public.whitelist ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.whitelist IS
  'Authorised email addresses. Only people listed here may sign up.';

COMMENT ON COLUMN public.whitelist.email IS
  'Email address (case-insensitive). Store in any case — comparisons use lower().';

COMMENT ON COLUMN public.whitelist.is_active IS
  'Set to false to revoke access without deleting the row.';


-- ─── check_whitelist() RPC ────────────────────────────────────────────────────
-- Called from the browser (anon role) immediately before sign-up.
-- Returns true  → email is whitelisted and active.
-- Returns false → not listed, or is_active = false.
-- SECURITY DEFINER lets it read the whitelist table despite the anon user
-- having no direct table access.
CREATE OR REPLACE FUNCTION public.check_whitelist(p_email text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM   public.whitelist
    WHERE  lower(email) = lower(p_email)
    AND    is_active = true
  );
END;
$$;

-- Grant execute to anonymous and authenticated roles so the app can call it.
GRANT EXECUTE ON FUNCTION public.check_whitelist(text) TO anon, authenticated;

COMMENT ON FUNCTION public.check_whitelist IS
  'Returns true if the email is in the whitelist and is_active. Safe to call from the browser — only returns a boolean, no table data exposed.';


-- ─── Add yourself (and any other authorised users) ────────────────────────────
-- Edit these rows before running, or add more INSERT statements as needed.
-- Use lowercase email addresses for consistency (the function normalises anyway).

INSERT INTO public.whitelist (email, full_name, notes) VALUES
  ('your.email@example.com', 'Your Name', 'Primary admin')
ON CONFLICT DO NOTHING;

-- Additional users — uncomment and edit as needed:
-- INSERT INTO public.whitelist (email, full_name, notes) VALUES
--   ('another@example.com', 'Another Person', ''),
--   ('family@example.com',  'Family Member',  '')
-- ON CONFLICT DO NOTHING;


-- ─── Useful admin queries ─────────────────────────────────────────────────────
-- View whitelist:
--   SELECT * FROM public.whitelist ORDER BY created_at;
--
-- Add a user:
--   INSERT INTO public.whitelist (email, full_name) VALUES ('new@example.com', 'New User');
--
-- Revoke access (without deleting):
--   UPDATE public.whitelist SET is_active = false WHERE email = 'someone@example.com';
--
-- Re-enable:
--   UPDATE public.whitelist SET is_active = true WHERE email = 'someone@example.com';
--
-- Delete permanently:
--   DELETE FROM public.whitelist WHERE email = 'someone@example.com';
