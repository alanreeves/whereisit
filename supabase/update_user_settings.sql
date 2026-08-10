-- =============================================================================
-- Migration: Add custom_prompt and min_match_score to user_settings
-- =============================================================================
-- Run this in: Supabase Dashboard → SQL Editor → New Query → Run

ALTER TABLE public.user_settings 
  ADD COLUMN IF NOT EXISTS custom_prompt text,
  ADD COLUMN IF NOT EXISTS min_match_score float8 NOT NULL DEFAULT 0.5;
