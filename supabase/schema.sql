-- =============================================================================
-- Where Is It? — Supabase Database Schema
-- =============================================================================
-- Run this in: Supabase Dashboard → SQL Editor → New Query → Run
--
-- Prerequisites (enable in Dashboard → Database → Extensions):
--   1. uuid-ossp   (usually pre-enabled)
--   2. vector      (pgvector — REQUIRED before running this script)
--   3. pg_trgm     (trigram fuzzy search)
-- =============================================================================

-- ─── Extensions ───────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- =============================================================================
-- TABLE: app_settings
-- Stores server-side API keys. Only readable by Edge Functions (service role).
-- NO user-facing RLS policies — effectively invisible to all browser clients.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.app_settings (
  id                integer PRIMARY KEY DEFAULT 1,
  openai_api_key    text    NOT NULL DEFAULT '',
  deepgram_api_key  text    NOT NULL DEFAULT '',
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- Enforce single row
  CONSTRAINT app_settings_single_row CHECK (id = 1)
);

-- RLS on but no policies = no browser access whatsoever.
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- Insert empty placeholder row (fill via SQL Editor, never via app).
INSERT INTO public.app_settings (id, openai_api_key, deepgram_api_key)
VALUES (1, '', '')
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.app_settings IS
  'Server-only API credentials. Only Supabase Edge Functions (service role) may read this table.';

-- =============================================================================
-- TABLE: user_settings
-- Per-user preferences — OpenAI model selection, future UI prefs.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.user_settings (
  user_id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  openai_model    text NOT NULL DEFAULT 'gpt-5.6-luna',
  custom_prompt   text,
  min_match_score float8 NOT NULL DEFAULT 0.5,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

-- Users may only read and write their own settings row.
CREATE POLICY "user_settings_select" ON public.user_settings
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "user_settings_insert" ON public.user_settings
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "user_settings_update" ON public.user_settings
  FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "user_settings_delete" ON public.user_settings
  FOR DELETE USING (user_id = auth.uid());

COMMENT ON COLUMN public.user_settings.openai_model IS
  'OpenAI model used for intent parsing. Default: gpt-5.6-luna';

-- =============================================================================
-- TABLE: items
-- Core inventory table. Every row is scoped to a single user via RLS.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.items (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  category    text,
  subcategory text,
  location    text        NOT NULL,
  notes       text,
  -- OpenAI text-embedding-3-small produces 1536-dimension vectors.
  embedding   vector(1536),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;

-- ─── RLS Policies (strict: user sees ONLY their own rows) ─────────────────────
CREATE POLICY "items_select" ON public.items
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "items_insert" ON public.items
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "items_update" ON public.items
  FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "items_delete" ON public.items
  FOR DELETE USING (user_id = auth.uid());

-- ─── Indexes ──────────────────────────────────────────────────────────────────

-- Standard btree for fast user-scoped lookups.
CREATE INDEX IF NOT EXISTS idx_items_user_id
  ON public.items (user_id);

-- Composite index for category-filtered searches.
CREATE INDEX IF NOT EXISTS idx_items_user_category
  ON public.items (user_id, category, subcategory);

-- IVFFlat index for approximate cosine similarity (pgvector).
-- lists=100 is appropriate for tables up to ~1 million rows.
-- Requires at least one row before the index can be created.
CREATE INDEX IF NOT EXISTS idx_items_embedding
  ON public.items USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- GIN trigram index for fast ILIKE / similarity fuzzy text search.
CREATE INDEX IF NOT EXISTS idx_items_name_trgm
  ON public.items USING gin (name gin_trgm_ops);

-- ─── updated_at trigger ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER items_updated_at
  BEFORE UPDATE ON public.items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE TRIGGER user_settings_updated_at
  BEFORE UPDATE ON public.user_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE TRIGGER app_settings_updated_at
  BEFORE UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =============================================================================
-- FUNCTION: hybrid_search
-- Combines pgvector cosine similarity and pg_trgm trigram similarity.
-- Called directly by the parse-intent Edge Function (service role).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.hybrid_search(
  p_user_id    uuid,
  p_query_text text,
  p_embedding  vector(1536),
  p_category   text    DEFAULT NULL,
  p_subcategory text   DEFAULT NULL,
  p_limit      integer DEFAULT 5
)
RETURNS TABLE (
  id          uuid,
  name        text,
  category    text,
  subcategory text,
  location    text,
  notes       text,
  created_at  timestamptz,
  updated_at  timestamptz,
  vector_score float,
  trgm_score   float,
  hybrid_score float
)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    i.id,
    i.name,
    i.category,
    i.subcategory,
    i.location,
    i.notes,
    i.created_at,
    i.updated_at,
    -- Cosine similarity: 1 = identical, 0 = orthogonal
    (1 - (i.embedding <=> p_embedding))::float                AS vector_score,
    -- Trigram similarity: 1 = identical match
    similarity(i.name, p_query_text)::float                   AS trgm_score,
    -- Weighted hybrid score (60% semantic, 40% lexical)
    (0.6 * (1 - (i.embedding <=> p_embedding)) +
     0.4 * similarity(i.name, p_query_text))::float           AS hybrid_score
  FROM public.items i
  WHERE
    i.user_id = p_user_id
    AND (p_category    IS NULL OR i.category    ILIKE p_category)
    AND (p_subcategory IS NULL OR i.subcategory ILIKE p_subcategory)
    AND i.embedding IS NOT NULL
  ORDER BY hybrid_score DESC
  LIMIT p_limit;
END;
$$;

COMMENT ON FUNCTION public.hybrid_search IS
  'Hybrid vector + trigram search for items. Called by the parse-intent Edge Function.';
