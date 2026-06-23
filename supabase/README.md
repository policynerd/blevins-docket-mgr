# Supabase Migrations

This project is linked to Supabase project `qpoupyodhhiupgalgbuf`.

The app still uses SQLite for its production data path. The first migration is intentionally a marker migration so Supabase CLI can initialize `supabase_migrations.schema_migrations` on the remote database.

## Initialize Remote Migration Tracking

From a local checkout:

```sh
npm run supabase:login
npm run supabase:link
npm run supabase:push
npm run supabase:migrations
```

`npm run supabase:push` should create the remote `supabase_migrations.schema_migrations` table and insert the initial migration version.

## Future Work

Replace the marker migration with real Postgres schema migrations as the app moves from SQLite to Supabase Postgres.
