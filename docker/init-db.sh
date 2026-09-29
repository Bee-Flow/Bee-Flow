#!/bin/bash
# Create additional databases needed by beeflow and enable pgvector
# The primary database (POSTGRES_DB) is created automatically by postgres
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    SELECT 'CREATE DATABASE beeflow_tasks' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'beeflow_tasks')\gexec
    SELECT 'CREATE DATABASE monitoring_db' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'monitoring_db')\gexec
    -- Dedicated database for the Bee Flow Hub / license server (module
    -- marketplace + license issuance). Used by the Bee Flow-internal
    -- license-server service in docker-compose.dev.yml ('hub' profile) and
    -- docker-compose.hub.local.yml, whose source is private; harmless when
    -- that service isn't run.
    SELECT 'CREATE DATABASE beeflow_hub' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'beeflow_hub')\gexec
    -- Dedicated database for the Umami website-analytics sidecar (the
    -- 'analytics' compose profile). Harmless when that profile is unused.
    SELECT 'CREATE DATABASE umami' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'umami')\gexec
EOSQL

# Enable pgvector extension in all databases that might store embeddings
for db in "$POSTGRES_DB" beeflow_tasks; do
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<-EOSQL
        CREATE EXTENSION IF NOT EXISTS vector;
EOSQL
done

echo "pgvector extension enabled in $POSTGRES_DB and beeflow_tasks"
