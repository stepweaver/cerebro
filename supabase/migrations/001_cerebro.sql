-- Cerebro: single-table mirror + lexical full-text search (no vectors in v1)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- thoughts: one row per mirrored Notion page (latest snapshot only)
-- ---------------------------------------------------------------------------
CREATE TABLE public.thoughts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL DEFAULT 'notion',
  source_key text NOT NULL UNIQUE,
  source_page_id text NOT NULL UNIQUE,
  source_url text,
  title text,
  content text NOT NULL DEFAULT '',
  raw_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding jsonb,
  enriched_at timestamptz,
  is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  content_tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A')
    || setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ) STORED
);

CREATE INDEX thoughts_content_tsv_gin ON public.thoughts USING gin (content_tsv);
CREATE INDEX thoughts_raw_metadata_gin ON public.thoughts USING gin (raw_metadata);
CREATE INDEX thoughts_updated_at_desc_idx ON public.thoughts (updated_at DESC);
CREATE INDEX thoughts_is_deleted_idx ON public.thoughts (is_deleted);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER thoughts_set_updated_at
  BEFORE UPDATE ON public.thoughts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security (service_role policy only)
-- ---------------------------------------------------------------------------
ALTER TABLE public.thoughts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access_thoughts"
  ON public.thoughts
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Lexical search (FTS + optional ILIKE fallback) for MCP tool
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lexical_search_thoughts(
  search_query text,
  result_limit int DEFAULT 10,
  include_deleted boolean DEFAULT false
)
RETURNS TABLE (
  id uuid,
  source text,
  source_key text,
  source_page_id text,
  source_url text,
  title text,
  content text,
  updated_at timestamptz,
  rank real
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q text;
  tsq tsquery;
BEGIN
  q := trim(coalesce(search_query, ''));
  IF q = '' OR result_limit < 1 THEN
    RETURN;
  END IF;

  BEGIN
    tsq := websearch_to_tsquery('english', q);
  EXCEPTION
    WHEN OTHERS THEN
      tsq := plainto_tsquery('english', q);
  END;

  IF tsq IS NULL OR tsq = ''::tsquery THEN
    RETURN QUERY
    SELECT
      t.id,
      t.source,
      t.source_key,
      t.source_page_id,
      t.source_url,
      t.title,
      t.content,
      t.updated_at,
      0::real AS rank
    FROM public.thoughts t
    WHERE (include_deleted OR NOT t.is_deleted)
      AND (t.title ILIKE '%' || q || '%' OR t.content ILIKE '%' || q || '%')
    ORDER BY t.updated_at DESC
    LIMIT result_limit;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.thoughts t
    WHERE (include_deleted OR NOT t.is_deleted)
      AND t.content_tsv @@ tsq
    LIMIT 1
  ) THEN
    RETURN QUERY
    SELECT
      t.id,
      t.source,
      t.source_key,
      t.source_page_id,
      t.source_url,
      t.title,
      t.content,
      t.updated_at,
      ts_rank_cd(t.content_tsv, tsq)::real AS rank
    FROM public.thoughts t
    WHERE (include_deleted OR NOT t.is_deleted)
      AND t.content_tsv @@ tsq
    ORDER BY rank DESC NULLS LAST, t.updated_at DESC
    LIMIT result_limit;
  ELSE
    RETURN QUERY
    SELECT
      t.id,
      t.source,
      t.source_key,
      t.source_page_id,
      t.source_url,
      t.title,
      t.content,
      t.updated_at,
      0::real AS rank
    FROM public.thoughts t
    WHERE (include_deleted OR NOT t.is_deleted)
      AND (t.title ILIKE '%' || q || '%' OR t.content ILIKE '%' || q || '%')
    ORDER BY t.updated_at DESC
    LIMIT result_limit;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.lexical_search_thoughts(text, int, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lexical_search_thoughts(text, int, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- Aggregated stats for MCP thought_stats tool (single round-trip)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cerebro_thought_stats()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'total', (SELECT COUNT(*)::int FROM public.thoughts),
    'active', (SELECT COUNT(*)::int FROM public.thoughts WHERE NOT is_deleted),
    'deleted', (SELECT COUNT(*)::int FROM public.thoughts WHERE is_deleted),
    'earliest_created_at', (SELECT MIN(created_at) FROM public.thoughts),
    'latest_updated_at', (SELECT MAX(updated_at) FROM public.thoughts),
    'by_source', COALESCE(
      (
        SELECT jsonb_object_agg(source, c)
        FROM (
          SELECT source, COUNT(*)::int AS c
          FROM public.thoughts
          GROUP BY source
        ) s
      ),
      '{}'::jsonb
    ),
    'with_title', (SELECT COUNT(*)::int FROM public.thoughts WHERE title IS NOT NULL AND btrim(title) <> ''),
    'without_title', (SELECT COUNT(*)::int FROM public.thoughts WHERE title IS NULL OR btrim(title) = ''),
    'awaiting_enrichment', (SELECT COUNT(*)::int FROM public.thoughts WHERE enriched_at IS NULL)
  );
$$;

REVOKE ALL ON FUNCTION public.cerebro_thought_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cerebro_thought_stats() TO service_role;
