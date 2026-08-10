#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: restore-postgres.sh <compose-directory> <custom-dump>" >&2
  exit 2
fi

compose_directory=$(realpath "$1")
backup_path=$(realpath "$2")
test -d "$compose_directory"
test -f "$backup_path"
test ! -L "$backup_path"
test "$(stat -c %a "$backup_path")" = "600"

cd "$compose_directory"
for attempt in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U odyshell -d odyshell >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo "PostgreSQL did not become ready" >&2
    exit 1
  fi
  sleep 1
done

container_id=$(docker compose ps -q postgres)
test -n "$container_id"
container_backup=/tmp/odyshell-restore.dump
docker cp "$backup_path" "$container_id:$container_backup" >/dev/null

cleanup_restore() {
  docker compose exec -T postgres rm -f "$container_backup" >/dev/null 2>&1 || true
  rm -f "$backup_path"
}
trap cleanup_restore EXIT

docker compose exec -T postgres pg_restore --exit-on-error --no-owner --no-privileges \
  -U odyshell -d odyshell "$container_backup"

organizations=$(docker compose exec -T postgres psql -U odyshell -d odyshell -Atqc \
  "select count(*) from odyshell.organizations")
machines=$(docker compose exec -T postgres psql -U odyshell -d odyshell -Atqc \
  "select count(*) from odyshell.machines")
printf "organizations=%s\nmachines=%s\n" "$organizations" "$machines"
