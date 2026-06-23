-- Initial Supabase migration marker.
--
-- The application still uses SQLite. This migration intentionally performs a
-- harmless query so `supabase db push` can initialize the remote migration
-- history table (`supabase_migrations.schema_migrations`) for project
-- qpoupyodhhiupgalgbuf.
--
-- Future migrations should port the SQLite schema from src/db.js to Postgres.

select 1;
