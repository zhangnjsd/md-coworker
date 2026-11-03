# md-coworker common tasks (run `just --list` to see them)
set shell := ["bash", "-uc"]

workspace := env("WORKSPACE", "./workspace")
bind      := env("BIND", "0.0.0.0:8001")
# Mount point when serving behind a reverse proxy on a sub-path, e.g. BASE_PATH=/cowork.
base_path := env("BASE_PATH", "")
base_flag := if base_path == "" { "" } else { "--base-path " + base_path }

# PostgreSQL: a project-local cluster keeps the demo self-contained. Point
# DATABASE_URL at your own server to skip all of the db-* recipes.
# The binary directory is discovered instead of pinned to one major version:
# PG_BIN wins, then `pg_config --bindir` (Debian/Ubuntu packaging), then the
# newest /usr/lib/postgresql/*/bin, then PATH.
pg_bin  := `if [ -n "${PG_BIN:-}" ]; then echo "$PG_BIN"; elif command -v pg_config >/dev/null 2>&1; then pg_config --bindir; elif ls -d /usr/lib/postgresql/*/bin >/dev/null 2>&1; then ls -d /usr/lib/postgresql/*/bin | sort -V | tail -n1; else dirname "$(command -v initdb)"; fi`
pg_port := env("PG_PORT", "5433")
pg_data := env("PG_DATA", "data/pg")
pg_user := env("PG_USER", "md_coworker")
pg_db   := env("PG_DB", "md_coworker")
db_url  := env("DATABASE_URL", "postgres://md_coworker@127.0.0.1:5433/md_coworker")

port   := `echo "${BIND:-0.0.0.0:8001}" | cut -d: -f2`
wsl_ip := `hostname -I | awk '{print $1}'`

# Frontend/tool dependencies run on npm, which ships with Node. bun is used only
# when npm is missing; it often lives in ~/.bun/bin without being on PATH.
node_pm := `if command -v npm >/dev/null 2>&1; then echo npm; elif command -v bun >/dev/null 2>&1; then echo bun; elif [ -x "$HOME/.bun/bin/bun" ]; then echo "$HOME/.bun/bin/bun"; else echo npm; fi`

# The seed of the first administrator. The server deletes this file as soon as
# that account has signed in once, so the smoke and browser tests need a copy:
# set MC_KEY_FILE, or re-run `just db-reset` to have a fresh one written.
key_file := env("MC_KEY_FILE", "data/bootstrap-admin.key")

# Print the Windows commands that put this server on the LAN (run them in an
# elevated PowerShell, then rerun this recipe whenever WSL gets a new address)
port-proxy:
    @echo "netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport={{port}} connectaddress={{wsl_ip}} connectport={{port}}"
    @echo "netsh advfirewall firewall add rule name='md-coworker {{port}}' dir=in action=allow protocol=TCP localport={{port}}"

# Undo the two rules above
port-proxy-remove:
    @echo "netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport={{port}}"
    @echo "netsh advfirewall firewall delete rule name='md-coworker {{port}}'"

# Default: list every recipe
default:
    @just --list

# Install dependencies for the frontend and the test scripts
install:
    cd web && {{node_pm}} install
    cd tools && {{node_pm}} install

# Build the frontend into web/dist
web:
    cd web && {{node_pm}} run build

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
    ./target/release/md-coworker {{workspace}} --bind {{bind}} --database-url {{db_url}} {{base_flag}}

# Run the debug build
dev: db-up
    cargo run -- {{workspace}} --bind {{bind}} --database-url {{db_url}} {{base_flag}}

# Unit tests
test:
    cargo test

# Everything CI would run: formatting, lints, unit tests, frontend build
check:
    cargo fmt --check
    cargo clippy --all-targets -- -D warnings
    cargo test
    cd web && {{node_pm}} run build

# API / WebSocket smoke test (the server must already be running)
smoke:
    @if [ ! -f "{{key_file}}" ]; then echo "缺少管理员私钥文件 {{key_file}}；把它保存到该路径，或用 MC_KEY_FILE 指定，或先 just db-reset" >&2; exit 1; fi
    MC_WS_ROOT={{workspace}} node tools/smoke.mjs http://{{bind}} {{key_file}}

# Real two-browser test (the server must already be running)
browser:
    @if [ ! -f "{{key_file}}" ]; then echo "缺少管理员私钥文件 {{key_file}}；把它保存到该路径，或用 MC_KEY_FILE 指定，或先 just db-reset" >&2; exit 1; fi
    MC_WS_FILE={{workspace}}/README.md node tools/browser.mjs http://{{bind}} {{key_file}}

# Regenerate the screenshots used by the README
shots:
    node tools/shots.mjs docs/screenshots

# Format Rust sources, the frontend and the test scripts
fmt:
    cargo fmt
    cd web && npx --yes prettier --write src index.html package.json
    cd tools && npx --yes prettier --write *.mjs

# Remove build output and local data (stops the local cluster first)
clean: db-down
    cargo clean
    rm -rf web/dist data

full-release:
    just web
    just release
