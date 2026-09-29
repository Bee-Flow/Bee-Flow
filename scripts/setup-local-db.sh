#!/bin/bash
# One-time local PostgreSQL setup for Bee Flow (no Docker)
# Run once after: sudo apt-get install -y postgresql-16 postgresql-16-pgvector
set -e

echo "[setup] Creating beeflow PostgreSQL user and databases..."

sudo -u postgres psql <<'SQL'
-- Create role if it doesn't exist
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'beeflow') THEN
    CREATE ROLE beeflow LOGIN PASSWORD 'beeflow';
  END IF;
END $$;

-- Create databases if they don't exist
SELECT 'CREATE DATABASE beeflow_core OWNER beeflow'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'beeflow_core')\gexec

SELECT 'CREATE DATABASE beeflow_tasks OWNER beeflow'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'beeflow_tasks')\gexec
SQL

echo "[setup] Enabling pgvector extension..."
for db in beeflow_core beeflow_tasks; do
  sudo -u postgres psql -d "$db" -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null \
    && echo "[setup]   vector enabled in $db" \
    || echo "[setup]   vector not available in $db (keyword search still works)"
done

echo "[setup] Done. You can now run: npm run dev:all"
