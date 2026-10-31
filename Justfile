# md-coworker 常用命令（just --list 查看）
set shell := ["bash", "-uc"]

workspace := env("WORKSPACE", "./demo-workspace")
bind      := env("BIND", "127.0.0.1:3000")

# 默认：列出所有命令
default:
    @just --list

# 安装前端与测试脚本依赖
install:
    cd web && npm install
    cd tools && npm install

# 构建前端产物到 web/dist
web:
    cd web && npm run build

# debug 构建后端
build:
    cargo build

# release 构建后端
release:
    cargo build --release

# 以 release 运行（WORKSPACE=... BIND=... just run）
run: release
    ./target/release/md-coworker {{workspace}} --bind {{bind}}

# 以 debug 运行
dev:
    cargo run -- {{workspace}} --bind {{bind}}

# 单元测试
test:
    cargo test

# 接口 / WebSocket 冒烟测试（需先启动服务）
smoke:
    MC_WS_ROOT={{workspace}} node tools/smoke.mjs http://{{bind}} data/bootstrap-admin.key

# 真浏览器双窗口测试（需先启动服务）
browser:
    MC_WS_FILE={{workspace}}/README.md node tools/browser.mjs http://{{bind}} data/bootstrap-admin.key

# 重新生成 README 里的界面截图
shots:
    node tools/shots.mjs docs/screenshots

# 格式化
fmt:
    cargo fmt
    -cd web && npx prettier --write 'src/**/*.{js,css}'

# 清理构建产物与本地数据
clean:
    cargo clean
    rm -rf web/dist data
