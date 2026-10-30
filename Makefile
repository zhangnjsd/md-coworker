# md-coworker 常用命令
WORKSPACE ?= ./demo-workspace
BIND ?= 127.0.0.1:3000

.PHONY: help install build release web run dev test smoke browser fmt clean

help:
	@echo "make install   安装前端依赖"
	@echo "make web       构建前端产物到 web/dist"
	@echo "make build     debug 构建后端"
	@echo "make release   release 构建后端"
	@echo "make run       以 release 运行（WORKSPACE=... BIND=...）"
	@echo "make dev       以 debug 运行"
	@echo "make test      单元测试 + 接口冒烟测试"
	@echo "make smoke     只跑接口冒烟测试（需先启动服务）"
	@echo "make browser   真浏览器双窗口测试（需先启动服务）"

install:
	cd web && npm install
	cd tools && npm install

web:
	cd web && npm run build

build:
	cargo build

release:
	cargo build --release

run: release
	./target/release/md-coworker $(WORKSPACE) --bind $(BIND)

dev:
	cargo run -- $(WORKSPACE) --bind $(BIND)

test:
	cargo test

smoke:
	node tools/smoke.mjs http://$(BIND) data/bootstrap-admin.key

browser:
	node tools/browser.mjs http://$(BIND) data/bootstrap-admin.key

fmt:
	cargo fmt
	cd web && npx prettier --write 'src/**/*.{js,css}' 2>/dev/null || true

clean:
	cargo clean
	rm -rf web/dist data
