# md-coworker common tasks (run `just --list` to see them)
set shell := ["bash", "-uc"]

workspace := env("WORKSPACE", "./demo-workspace")
bind      := env("BIND", "127.0.0.1:3000")

# Default: list every recipe
default:
    @just --list

# Install dependencies for the frontend and the test scripts
install:
    cd web && npm install
    cd tools && npm install

# Build the frontend into web/dist
web:
    cd web && npm run build

# Build the backend (debug)
build:
    cargo build

# Build the backend (release)
release:
    cargo build --release

# Build release and run it (WORKSPACE=... BIND=... just run)
run: release
    ./target/release/md-coworker {{workspace}} --bind {{bind}}

# Run the debug build
dev:
    cargo run -- {{workspace}} --bind {{bind}}

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

# Format sources
fmt:
    cargo fmt
    -cd web && npx prettier --write 'src/**/*.{js,css}'

# Remove build output and local data
clean:
    cargo clean
    rm -rf web/dist data
