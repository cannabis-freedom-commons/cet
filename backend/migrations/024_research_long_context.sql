ALTER TABLE research_runs ADD COLUMN long_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE research_runs ADD COLUMN long_cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE research_runs ADD COLUMN long_cache_write_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE research_runs ADD COLUMN long_output_tokens INTEGER NOT NULL DEFAULT 0;
