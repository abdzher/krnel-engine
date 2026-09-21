#!/usr/bin/env bash
# =============================================================================
# KRNEL — tests/demo-concurrencia/scripts/append-allowlist.sh
# Agrega las cuentas demo-01..demo-NN a files/allowlist.txt si aún no están.
# NO imprime el contenido del archivo (tiene ~119 correos reales de estudiantes).
#
# Uso:
#   scripts/append-allowlist.sh [N]            # N = cantidad, default 5
#   DEMO_USERNAME_TEMPLATE='demo-{n}' scripts/append-allowlist.sh 5
#
# Después:
#   ansible-playbook playbooks/05-jupyterhub.yml --tags update \
#       --ask-vault-pass --ask-become-pass
# =============================================================================
set -euo pipefail

N="${1:-5}"
TEMPLATE="${DEMO_USERNAME_TEMPLATE:-demo-{n}}"

# Ubicar la raíz del repo desde este script.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ALLOWLIST="$REPO_ROOT/files/allowlist.txt"

if [[ ! -f "$ALLOWLIST" ]]; then
  echo "ERROR: no existe $ALLOWLIST" >&2
  echo "Copiá files/allowlist.example.txt a files/allowlist.txt primero." >&2
  exit 1
fi

# Asegurar salto de línea final antes de agregar.
[[ -n "$(tail -c1 "$ALLOWLIST")" ]] && printf '\n' >> "$ALLOWLIST"

added=0
for ((i = 1; i <= N; i++)); do
  nn=$(printf '%02d' "$i")
  user="${TEMPLATE/\{n\}/$nn}"
  if grep -qxF "$user" "$ALLOWLIST"; then
    echo "  = $user (ya estaba)"
  else
    printf '%s\n' "$user" >> "$ALLOWLIST"
    echo "  + $user"
    added=$((added + 1))
  fi
done

echo
echo "$added cuenta(s) agregada(s) a files/allowlist.txt."
echo "Re-aplicá el Hub:  ansible-playbook playbooks/05-jupyterhub.yml --tags update --ask-vault-pass --ask-become-pass"
