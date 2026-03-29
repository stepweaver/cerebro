-- Hybrid capture: Slack inbox + Notion mirror share `thoughts`.
-- Slack rows use source_key only; source_page_id stays NULL.
-- Notion rows keep unique source_page_id when set.

ALTER TABLE public.thoughts
  ALTER COLUMN source_page_id DROP NOT NULL;

ALTER TABLE public.thoughts
  ALTER COLUMN source DROP DEFAULT;

CREATE INDEX IF NOT EXISTS thoughts_source_idx ON public.thoughts (source);

-- Replace search RPC with optional source filter
DROP FUNCTION IF EXISTS public.lexical_search_thoughts(text, int, boolean);

CREATE OR REPLACE FUNCTION public.lexical_search_thoughts(
  search_query text,
  result_limit int DEFAULT 10,
  include_deleted boolean DEFAULT false,
  filter_source text DEFAULT NULL
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
      AND (filter_source IS NULL OR t.source = filter_source)
      AND (t.title ILIKE '%' || q || '%' OR t.content ILIKE '%' || q || '%')
    ORDER BY t.updated_at DESC
    LIMIT result_limit;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.thoughts t
    WHERE (include_deleted OR NOT t.is_deleted)
      AND (filter_source IS NULL OR t.source = filter_source)
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
      AND (filter_source IS NULL OR t.source = filter_source)
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
      AND (filter_source IS NULL OR t.source = filter_source)
      AND (t.title ILIKE '%' || q || '%' OR t.content ILIKE '%' || q || '%')
    ORDER BY t.updated_at DESC
    LIMIT result_limit;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.lexical_search_thoughts(text, int, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lexical_search_thoughts(text, int, boolean, text) TO service_role;
