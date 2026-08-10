-- =============================================================================
-- Where Is It? — API Cost & Model Rates Tracking
-- =============================================================================
-- Run this script in: Supabase Dashboard → SQL Editor → New Query → Run
-- =============================================================================

-- ─── Table 1: Model Cost Rates (Per User) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_model_rates (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  model                   text        NOT NULL,
  prompt_cost_per_1k      float8      NOT NULL DEFAULT 0.00015,  -- USD cost per 1,000 input tokens
  completion_cost_per_1k  float8      NOT NULL DEFAULT 0.0006,   -- USD cost per 1,000 output tokens
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_model_rates_user_model_key UNIQUE (user_id, model)
);

ALTER TABLE public.user_model_rates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_model_rates_select" ON public.user_model_rates
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "user_model_rates_insert" ON public.user_model_rates
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "user_model_rates_update" ON public.user_model_rates
  FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "user_model_rates_delete" ON public.user_model_rates
  FOR DELETE USING (user_id = auth.uid());


-- ─── Table 2: API Usage Logs (Per Request) ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.api_usage_logs (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  model              text        NOT NULL,
  prompt_tokens      integer     NOT NULL DEFAULT 0,
  completion_tokens  integer     NOT NULL DEFAULT 0,
  total_tokens       integer     NOT NULL DEFAULT 0,
  cost               float8      NOT NULL DEFAULT 0.0,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_usage_logs_user_id ON public.api_usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_api_usage_logs_created ON public.api_usage_logs(created_at);

ALTER TABLE public.api_usage_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "api_usage_logs_select" ON public.api_usage_logs
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "api_usage_logs_insert" ON public.api_usage_logs
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "api_usage_logs_delete" ON public.api_usage_logs
  FOR DELETE USING (user_id = auth.uid());


-- ─── Function: Reset Accumulated Cost for User ─────────────────────────────
CREATE OR REPLACE FUNCTION public.reset_user_cost(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.api_usage_logs
  WHERE user_id = p_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reset_user_cost(uuid) TO authenticated;
