# md-coworker common tasks (run `just --list` to see them)
set shell := ["bash", "-uc"]

workspace := env("WORKSPACE", "./demo-workspace")
bind      := env("BIND", "127.0.0.1:3000")

# PostgreSQL: a project-local cluster keeps the demo self-contained. Point
# DATABASE_URL at your own server to skip all of the db-* recipes.
pg_bin  := env("PG_BIN", "/usr/lib/postgresql/18/bin")
pg_port := env("PG_PORT", "5433")
pg_data := env("PG_DATA", "data/pg")
pg_user := env("PG_USER", "md_coworker")
pg_db   := env("PG_DB", "md_coworker")
db_url  := env("DATABASE_URL", "postgres://md_coworker@127.0.0.1:5433/md_coworker")

# bun often lives in ~/.bun/bin without being on PATH.
bun := `command -v bun || echo "$HOME/.bun/bin/bun"`

# Default: list every recipe
default:
    @just --list

# Install dependencies for the frontend and the test scripts
install:
    cd web && {{bun}} install
    cd tools && {{bun}} install

# Build the frontend into web/dist
web:
    cd web && {{bun}} run build

# Build the backend (debug)
build:
    cargo build

# Build the backend (release)
release:
    cargo build --release

# Create the local PostgreSQL cluster (first run only)
db-init:
    #!/usr/bin/env bash
    set -eu
    if [ -d {{pg_data}}/base ]; then
      echo "database cluster already initialised at {{pg_data}}"
      exit 0
    fi
    if [ ! -x {{pg_bin}}/initdb ]; then
      echo "找不到 {{pg_bin}}/initdb，请用 PG_BIN 指向 PostgreSQL 的 bin 目录" >&2
      exit 1
    fi
    mkdir -p "$(dirname {{pg_data}})"
    {{pg_bin}}/initdb -D {{pg_data}} -U {{pg_user}} --auth=trust --encoding=UTF8 --locale=C >/dev/null
    echo "initialised {{pg_data}}"

# Start the local PostgreSQL cluster (idempotent)
db-up: db-init
    #!/usr/bin/env bash
    set -eu
    if {{pg_bin}}/pg_isready -h 127.0.0.1 -p {{pg_port}} -q; then
      echo "PostgreSQL already listening on 127.0.0.1:{{pg_port}}"
    else
      {{pg_bin}}/pg_ctl -D {{pg_data}} -l /tmp/md-coworker-pg.log \
        -o "-p {{pg_port}} -k /tmp -c listen_addresses=127.0.0.1" start >/dev/null
      echo "started PostgreSQL on 127.0.0.1:{{pg_port}} (log: /tmp/md-coworker-pg.log)"
    fi
    {{pg_bin}}/psql -h 127.0.0.1 -p {{pg_port}} -U {{pg_user}} -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname = '{{pg_db}}'" | grep -q 1 \
      || {{pg_bin}}/createdb -h 127.0.0.1 -p {{pg_port}} -U {{pg_user}} {{pg_db}}

# Stop the local PostgreSQL cluster
db-down:
    -{{pg_bin}}/pg_ctl -D {{pg_data}} -m fast stop

# Drop and recreate the local database (destroys all users and sessions)
db-reset: db-down
    rm -rf {{pg_data}}
    just db-up

# Open a psql shell on the local cluster
db-psql:
    {{pg_bin}}/psql {{db_url}}

# Show tables and row counts
db-status:
    {{pg_bin}}/psql {{db_url}} -c "\dt" -c "SELECT count(*) AS users FROM users"

# Build release and run it (WORKSPACE=... BIND=... just run)
run: db-up release
    ./target/release/md-coworker {{workspace}} --bind {{bind}} --database-url {{db_url}}

# Run the debug build
dev: db-up
    cargo run -- {{workspace}} --bind {{bind}} --database-url {{db_url}}

# Unit tests
test:
    cargo test

# API / WebSocket smoke test (the server must already be running)
smoke:
    MC_WS_ROOT={{workspace}} node tools/smoke.mjs http://{{bind}} data/bootstrap-admin.key

# Real two-browser test (the server must already be running)
browser:
    MC_WS_FILE={{workspace}}/README.md node tools/browser.mjs http://{{bind}} data/bootstrap-admin.key

# Regenerate the screenshots used by the README
shots:
    node tools/shots.mjs docs/screenshots

# Format Rust sources (the frontend is hand-formatted, no prettier configured)
fmt:
    cargo fmt

# Remove build output and local data (stops the local cluster first)
clean: db-down
    cargo clean
    rm -rf web/dist data
