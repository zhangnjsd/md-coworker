#!/usr/bin/env bash
#
# md-coworker 备份脚本
#
# 一次备份覆盖三处数据：
#   1. PostgreSQL（pg_dump -Fc）—— 用户、会话、挑战、mfa_tickets、settings
#   2. 工作区明文文件（tar）—— 真正的文档内容
#   3. data/（tar）—— master.key 主密钥 + crdt/ 加密快照
#
# 用法：
#   ./deploy/backup.sh                                   # 用下面的默认路径
#   BACKUP_DIR=/var/backups/md-coworker ./deploy/backup.sh
#   WORKSPACE_DIR=/srv/md-coworker/workspace DATA_DIR=/srv/md-coworker/data \
#     DATABASE_URL=postgres://md_coworker@127.0.0.1:5433/md_coworker ./deploy/backup.sh
#
# 可用环境变量（都有默认值）：
#   BACKUP_DIR     备份输出目录，默认 ./backups
#   WORKSPACE_DIR  工作区目录，默认 /srv/md-coworker/workspace
#   DATA_DIR       数据目录（含 master.key 与 crdt/），默认 /srv/md-coworker/data
#   DATABASE_URL   PostgreSQL 连接串，默认与 justfile 一致：127.0.0.1:5433
#
# 建议放进 cron / systemd timer，例如每天 03:17（UTC）：
#   17 3 * * * /srv/md-coworker/deploy/backup.sh >> /var/log/md-coworker-backup.log 2>&1

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
WORKSPACE_DIR="${WORKSPACE_DIR:-/srv/md-coworker/workspace}"
DATA_DIR="${DATA_DIR:-/srv/md-coworker/data}"
DATABASE_URL="${DATABASE_URL:-postgres://md_coworker@127.0.0.1:5433/md_coworker}"

TS="$(date -u +%Y%m%dT%H%M%SZ)"

log() { printf '[backup] %s\n' "$*"; }
die() { printf '[backup] 错误: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 前置检查
command -v pg_dump >/dev/null 2>&1 \
  || die "找不到 pg_dump，请安装 postgresql-client（版本不低于服务端主版本）"
command -v tar >/dev/null 2>&1 || die "找不到 tar"
command -v sha256sum >/dev/null 2>&1 || die "找不到 sha256sum"

[ -d "$WORKSPACE_DIR" ] || die "工作区目录不存在: $WORKSPACE_DIR"
[ -d "$DATA_DIR" ]      || die "数据目录不存在: $DATA_DIR"
[ -f "$DATA_DIR/master.key" ] \
  || log "警告: 未见 $DATA_DIR/master.key —— 这份备份将无法解开 crdt 快照"

mkdir -p "$BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
WORKSPACE_DIR="$(cd "$WORKSPACE_DIR" && pwd)"
DATA_DIR="$(cd "$DATA_DIR" && pwd)"

# 防呆：工作区会通过 HTTP 对外提供，备份绝不能落在里面
case "$BACKUP_DIR/" in
  "$WORKSPACE_DIR"/*) die "备份目录不能位于工作区内: $BACKUP_DIR" ;;
esac
# 同理别写进 data/（那里只有主密钥和快照，也不该混入大文件）
case "$BACKUP_DIR/" in
  "$DATA_DIR"/*) die "备份目录不能位于数据目录内: $BACKUP_DIR" ;;
esac

DB_FILE="$BACKUP_DIR/md-coworker-db-$TS.dump"
WS_FILE="$BACKUP_DIR/md-coworker-workspace-$TS.tar.gz"
DATA_FILE="$BACKUP_DIR/md-coworker-data-$TS.tar.gz"
MANIFEST="$BACKUP_DIR/md-coworker-manifest-$TS.txt"

# 中途失败时删掉半成品，避免留下「看起来能用」的残缺备份
cleanup() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    printf '[backup] 失败（退出码 %s），删除本次半成品\n' "$code" >&2
    rm -f "$DB_FILE" "$WS_FILE" "$DATA_FILE" "$MANIFEST"
  fi
}
trap cleanup EXIT

log "开始备份 (UTC $TS)"

# ---------------------------------------------------------------- 1. 数据库
log "1/3 pg_dump -Fc -> $DB_FILE"
# --no-owner / --no-privileges：恢复到另一个集群或另一个用户名时不会卡在「角色不存在」
pg_dump --format=custom --no-owner --no-privileges \
        --file="$DB_FILE" "$DATABASE_URL"

# ---------------------------------------------------------------- 2. 工作区
log "2/3 打包工作区 -> $WS_FILE"
# 以 . 为根打包，恢复时直接 tar -C <工作区> -xzf，不会写出多余的一层目录
tar -C "$WORKSPACE_DIR" -czf "$WS_FILE" .

# ---------------------------------------------------------------- 3. data/
log "3/3 打包数据目录（master.key + crdt/）-> $DATA_FILE"
# --exclude=./pg：justfile 的本地 PostgreSQL 集群就落在 data/pg，
# 那是活的数据库目录，塞进 tar 又大又不可靠（数据库由 pg_dump 负责）。
# --exclude=./tmp：上传用的临时文件，可重建。
tar -C "$DATA_DIR" \
    --exclude=./pg --exclude='./pg/*' \
    --exclude=./tmp --exclude='./tmp/*' \
    -czf "$DATA_FILE" .

# ---------------------------------------------------------------- 主密钥警告
if [ -f "$DATA_DIR/master.key" ]; then
  cat <<'WARN'

==================================================================
  ⚠  本次备份包含 data/master.key（快照加密主密钥）
     · 丢了它：data/crdt/ 里的所有快照都解不开（历史与协作结构丢失）
     · 有了它：拿到这份备份的人可以解开全部快照
     请把它当机密数据保管：不要进 git、不要放公开对象存储、
     不要和代码仓库一起打包；建议单独 gpg -c 加密后异地保存。
==================================================================

WARN
fi

# ---------------------------------------------------------------- 清单
{
  echo "# md-coworker backup manifest"
  echo "time_utc=$TS"
  echo "host=$(hostname 2>/dev/null || echo unknown)"
  # 打印连接串时抹掉口令，避免清单本身泄露凭据
  echo "database_url=$(printf '%s' "$DATABASE_URL" | sed -E 's#(//[^:/@]*):[^@]*@#\1:***@#')"
  echo "workspace_dir=$WORKSPACE_DIR"
  echo "data_dir=$DATA_DIR"
  echo
  for f in "$DB_FILE" "$WS_FILE" "$DATA_FILE"; do
    printf 'file=%s size=%s sha256=%s\n' \
      "$(basename "$f")" \
      "$(du -h "$f" | cut -f1)" \
      "$(sha256sum "$f" | cut -d' ' -f1)"
  done
  echo
  if [ -f "$DATA_DIR/master.key" ]; then
    printf 'master_key=present sha256=%s\n' "$(sha256sum "$DATA_DIR/master.key" | cut -d' ' -f1)"
  else
    echo "master_key=absent"
  fi
  printf 'crdt_snapshots=%s\n' "$(find "$DATA_DIR/crdt" -type f 2>/dev/null | wc -l | tr -d ' ')"
  printf 'workspace_files=%s\n' "$(find "$WORKSPACE_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')"
} > "$MANIFEST"

trap - EXIT
log "完成: $MANIFEST"
grep -E '^(file|master_key|crdt_snapshots|workspace_files)=' "$MANIFEST" | sed 's/^/[backup]   /'

# ---------------------------------------------------------------- 恢复摘要
cat <<EOF

恢复步骤（顺序别换）：
  0) 停服务，恢复期间不要再写入
     sudo systemctl stop md-coworker

  1) 数据库（自定义格式，--clean --if-exists 会先清掉同名对象再重建）
     pg_restore --clean --if-exists --no-owner -d "\$DATABASE_URL" "$DB_FILE"

  2) 工作区明文文件（先自己留一份现有目录的副本）
     sudo tar -C "$WORKSPACE_DIR" -xzf "$WS_FILE"

  3) data/：master.key 与 crdt/ 必须配套
     sudo tar -C "$DATA_DIR" -xzf "$DATA_FILE"
     用另一把 master.key 配这批快照 => 快照解不开（按「无历史」处理），
     但工作区里的明文文档照样能读能编辑：最坏只丢最后一次 400ms 防抖窗口内的改动。

  4) 权限修回来，然后起服务并探活
     sudo chown -R cowork:cowork "$WORKSPACE_DIR" "$DATA_DIR"
     sudo chmod 700 "$DATA_DIR" && sudo chmod 600 "$DATA_DIR/master.key"
     sudo systemctl start md-coworker
     curl -fsS http://127.0.0.1:3001/api/health

注意：备份里的工作区是明文文档，压缩包不加密，请按机密数据保存。
EOF
