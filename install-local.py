#!/usr/bin/env python3
"""
Bee Flow AI — one-time local install (Linux / macOS).

Sets up the *core services only* (frontend + backend + a PostgreSQL container)
for local laptop/desktop development. Run this once. After it finishes, start
the stack with `npm run dev:all`.

Usage:
    python3 install-local.py
"""

import os
import secrets
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ENV_FILE = ROOT / ".env"
ENV_EXAMPLE = ROOT / ".env.example"

# Non-standard ports to avoid colliding with other Postgres / dev servers on the host.
PG_CONTAINER = "beeflow-postgres"
PG_IMAGE = "pgvector/pgvector:pg15"
PG_USER = "beeflow"
PG_PASSWORD = "beeflow"
PG_DB = "beeflow_core"           # primary DB the server reads via CORE_DATABASE_URL
PG_DB_TASKS = "beeflow_tasks"    # secondary DB read via DATABASE_URL
PG_DB_MONITORING = "monitoring_db"
PG_PORT = "55432"        # host port -> container's 5432
SERVER_PORT = "3101"     # backend
CLIENT_PORT = "5276"     # frontend (Vite)


# ---------- helpers ----------

class Color:
    OK = "\033[92m"
    WARN = "\033[93m"
    ERR = "\033[91m"
    INFO = "\033[94m"
    BOLD = "\033[1m"
    END = "\033[0m"


def step(msg: str) -> None:
    print(f"\n{Color.BOLD}{Color.INFO}==> {msg}{Color.END}")


def ok(msg: str) -> None:
    print(f"{Color.OK}    OK{Color.END} {msg}")


def warn(msg: str) -> None:
    print(f"{Color.WARN}    !!{Color.END} {msg}")


def fail(msg: str) -> None:
    print(f"{Color.ERR}    FAIL{Color.END} {msg}")
    sys.exit(1)


def have(cmd: str) -> bool:
    return shutil.which(cmd) is not None


def run(cmd: list[str], cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess:
    print(f"    $ {' '.join(cmd)}")
    return subprocess.run(cmd, cwd=cwd, check=check)


def run_capture(cmd: list[str]) -> str:
    return subprocess.run(cmd, capture_output=True, text=True).stdout.strip()


# ---------- steps ----------

def check_prerequisites() -> None:
    step("Checking prerequisites")

    if not have("node"):
        fail("Node.js is not installed. Install Node.js 20+ from https://nodejs.org/")
    node_version = run_capture(["node", "--version"])
    ok(f"node {node_version}")

    if not have("npm"):
        fail("npm is not installed. It ships with Node.js.")
    ok(f"npm {run_capture(['npm', '--version'])}")

    if not have("docker"):
        warn("Docker not found — you will need to install PostgreSQL with pgvector manually.")
        warn("Install Docker from https://docs.docker.com/engine/install/ and re-run this script.")
    else:
        ok(f"docker {run_capture(['docker', '--version'])}")


def install_npm_dependencies() -> None:
    step("Installing npm dependencies (root, server, agent-hub)")
    run(["npm", "install"], cwd=ROOT)
    run(["npm", "install"], cwd=ROOT / "server")
    run(["npm", "install"], cwd=ROOT / "agent-hub")
    ok("dependencies installed")


def start_postgres() -> None:
    step("Starting PostgreSQL (pgvector) container")

    if not have("docker"):
        warn("Skipping — Docker not available. Make sure PostgreSQL 15+ with pgvector is")
        warn(f"running on localhost:{PG_PORT} with database '{PG_DB}' (user '{PG_USER}').")
        return

    existing = run_capture(["docker", "ps", "-a", "--filter", f"name=^{PG_CONTAINER}$", "--format", "{{.Names}}"])
    if existing == PG_CONTAINER:
        running = run_capture(["docker", "ps", "--filter", f"name=^{PG_CONTAINER}$", "--format", "{{.Names}}"])
        if running == PG_CONTAINER:
            ok(f"container '{PG_CONTAINER}' already running")
            return
        # Stopped container exists. Its port mapping may be stale (e.g. from an
        # earlier install that used a different port). Remove and recreate.
        warn(f"removing stopped container '{PG_CONTAINER}' to recreate with current port mapping")
        run(["docker", "rm", "-f", PG_CONTAINER])

    init_script = ROOT / "docker" / "init-db.sh"
    if not init_script.exists():
        fail(f"missing {init_script} — needed to create beeflow_tasks/monitoring_db and enable pgvector")

    run([
        "docker", "run", "-d",
        "--name", PG_CONTAINER,
        "-e", f"POSTGRES_USER={PG_USER}",
        "-e", f"POSTGRES_PASSWORD={PG_PASSWORD}",
        "-e", f"POSTGRES_DB={PG_DB}",
        "-p", f"{PG_PORT}:5432",
        "-v", f"{init_script}:/docker-entrypoint-initdb.d/init-db.sh:ro",
        PG_IMAGE,
    ])
    ok(f"container '{PG_CONTAINER}' created (DBs: {PG_DB}, {PG_DB_TASKS}, {PG_DB_MONITORING})")


def wait_for_postgres(timeout_seconds: int = 60) -> None:
    step("Waiting for PostgreSQL to be ready")
    if not have("docker"):
        warn("Skipping wait — Docker not available")
        return
    import time
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        result = subprocess.run(
            ["docker", "exec", PG_CONTAINER, "pg_isready", "-U", PG_USER, "-d", PG_DB],
            capture_output=True,
        )
        if result.returncode == 0:
            ok("PostgreSQL is accepting connections")
            return
        time.sleep(1)
    fail(f"PostgreSQL did not become ready within {timeout_seconds}s")


def create_env_file() -> None:
    step("Configuring .env")

    if ENV_FILE.exists():
        ok(".env already exists — leaving it untouched")
        return

    if not ENV_EXAMPLE.exists():
        fail(".env.example is missing; cannot generate .env")

    contents = ENV_EXAMPLE.read_text()
    session_secret = secrets.token_hex(32)

    db_base = f"postgresql://{PG_USER}:{PG_PASSWORD}@localhost:{PG_PORT}"
    replacements = {
        "SESSION_SECRET=your-super-secure-session-secret-change-me": f"SESSION_SECRET={session_secret}",
        "VITE_API_URL=": f"VITE_API_URL=http://localhost:{SERVER_PORT}",
        "DATABASE_URL=postgresql://beeflow:beeflow@localhost:5432/beeflow_tasks":
            f"DATABASE_URL={db_base}/{PG_DB_TASKS}",
        "SERVER_PORT=3001": f"SERVER_PORT={SERVER_PORT}",
        "CLIENT_PORT=5176": f"CLIENT_PORT={CLIENT_PORT}",
    }
    for old, new in replacements.items():
        contents = contents.replace(old, new)

    # The server reads CORE_DATABASE_URL (main DB) and MONITORING_DATABASE_URL,
    # but .env.example only ships DATABASE_URL. Append the missing two.
    extras = (
        "\n# --- Added by install-local.py ---\n"
        f"CORE_DATABASE_URL={db_base}/{PG_DB}\n"
        f"MONITORING_DATABASE_URL={db_base}/{PG_DB_MONITORING}\n"
    )
    contents = contents.rstrip() + "\n" + extras

    ENV_FILE.write_text(contents)
    ok(".env created with a freshly generated SESSION_SECRET")


def run_migrations() -> None:
    step("Running database migrations")
    try:
        run(["npm", "run", "db:migrate"], cwd=ROOT / "server")
        ok("migrations complete")
    except subprocess.CalledProcessError:
        warn("migrations failed — Postgres may still be starting. Re-run later with:")
        warn("    cd server && npm run db:migrate")


def print_next_steps() -> None:
    print(f"\n{Color.BOLD}{Color.OK}Install complete!{Color.END}\n")
    print(f"{Color.BOLD}To start Bee Flow AI next time, run from this folder:{Color.END}\n")
    print(f"    {Color.INFO}npm run dev:all{Color.END}\n")
    print("Or in two terminals:")
    print(f"    {Color.INFO}npm run dev:server{Color.END}     # backend  -> http://localhost:{SERVER_PORT}")
    print(f"    {Color.INFO}npm run dev:frontend{Color.END}   # frontend -> http://localhost:{CLIENT_PORT}\n")
    print(f"PostgreSQL runs in Docker as '{PG_CONTAINER}' on host port {PG_PORT}. Manage it with:")
    print(f"    {Color.INFO}docker start {PG_CONTAINER}{Color.END}    # start the database")
    print(f"    {Color.INFO}docker stop  {PG_CONTAINER}{Color.END}    # stop it when you're done\n")
    print(f"Open the Agent Hub at: http://localhost:{CLIENT_PORT}\n")


def main() -> None:
    print(f"{Color.BOLD}Bee Flow AI — local install (core services){Color.END}")
    check_prerequisites()
    install_npm_dependencies()
    start_postgres()
    create_env_file()
    wait_for_postgres()
    run_migrations()
    print_next_steps()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nAborted.")
        sys.exit(130)
