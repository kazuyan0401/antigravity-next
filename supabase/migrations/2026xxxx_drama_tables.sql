-- ============================================================
-- ドラマ機能 追加スキーマ
-- 用途: crank-in.netから取得した季節ドラマを監視対象として保持し、
--       放送日に合わせて公式サイト→AI→postsへ流す
-- 実行先: Supabase SQL Editor
-- ============================================================

-- ドラマ本体（監視対象）
CREATE TABLE IF NOT EXISTS dramas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  network text,
  official_url text,
  air_day_of_week int,           -- 0=日, 1=月, 2=火, ..., 6=土。NULL=帯/不定
  is_daily boolean DEFAULT false, -- 朝ドラ等の毎日放送フラグ
  air_time text,                  -- "21:00" 形式の文字列
  season text,                    -- "spring2026" 等
  synopsis text,
  original_works text,            -- 原作情報（漫画/小説/オリジナル等）
  soundtrack_info text,           -- 主題歌・OST情報
  cast_info text,
  enabled boolean DEFAULT true,   -- false=処理対象外
  last_processed_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dramas_enabled_dow ON dramas(enabled, air_day_of_week);
CREATE INDEX IF NOT EXISTS idx_dramas_enabled_daily ON dramas(enabled, is_daily);
CREATE INDEX IF NOT EXISTS idx_dramas_season ON dramas(season);

-- 処理キュー
CREATE TABLE IF NOT EXISTS drama_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drama_id uuid REFERENCES dramas(id) ON DELETE CASCADE,
  scheduled_for date NOT NULL,
  status text DEFAULT 'pending',  -- pending / processing / done / failed
  error_message text,
  created_at timestamptz DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_drama_queue_status ON drama_queue(status, created_at);

-- 同じドラマを同日に二重キューしない
CREATE UNIQUE INDEX IF NOT EXISTS uq_drama_queue_drama_day
  ON drama_queue(drama_id, scheduled_for);
