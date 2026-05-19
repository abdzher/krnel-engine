#!/usr/bin/env python3
# =============================================================================
# KRNEL — Diagnóstico Completo de Spark sobre Kubernetes
# =============================================================================
#
# Este script analiza TODAS las capas de conectividad entre el pod de
# JupyterHub y el API Server de Kubernetes para determinar por qué Spark
# no puede crear su SparkContext.
#
# Ejecutar desde un perfil con service_account: spark-editor
# (Comunidad, Profesor, o Administrador).
#
# El script:
#   1. Inspecciona el entorno del pod (red, DNS, variables, etc.)
#   2. Prueba conectividad TCP a múltiples endpoints del API Server
#   3. Valida la autenticación con el ServiceAccount token
#   4. Intenta crear SparkSession con distintas configuraciones
#   5. Guarda un log detallado en ~/Comunidad/spark-diagnostico.log
#
# Autor: KRNEL Engine (generado automáticamente)
# =============================================================================

import os
import sys
import json
import socket
import ssl
import time
import subprocess
import traceback
from datetime import datetime
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import URLError

# =============================================================================
# CONFIGURACIÓN
# =============================================================================
LOG_DIR = Path.home() / "Comunidad"
LOG_FILE = LOG_DIR / "spark-diagnostico.log"
SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token"
SA_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
SA_NS_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/namespace"

# Endpoints candidatos para spark.master (orden de prioridad)
# Cada tupla: (nombre_descriptivo, url_para_spark_master, host_para_tcp, puerto)
MASTER_CANDIDATES = [
    (
        "ClusterIP (estándar)",
        "k8s://https://kubernetes.default.svc:443",
        "kubernetes.default.svc",
        443,
    ),
    (
        "ClusterIP FQDN",
        "k8s://https://kubernetes.default.svc.cluster.local:443",
        "kubernetes.default.svc.cluster.local",
        443,
    ),
    (
        "ClusterIP directo (172.21.0.1)",
        "k8s://https://172.21.0.1:443",
        "172.21.0.1",
        443,
    ),
    (
        "Master físico nd-1 (10.12.32.243:6443)",
        "k8s://https://10.12.32.243:6443",
        "10.12.32.243",
        6443,
    ),
]

# =============================================================================
# UTILIDADES DE LOGGING
# =============================================================================
_log_lines = []


def log(msg, level="INFO"):
    """Imprime y almacena una línea de log."""
    ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    line = f"[{ts}] [{level:>5}] {msg}"
    print(line)
    _log_lines.append(line)


def log_section(title):
    """Separador visual para secciones del diagnóstico."""
    sep = "=" * 72
    log("")
    log(sep)
    log(f"  {title}")
    log(sep)


def save_log():
    """Guarda el log completo a disco."""
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        LOG_FILE.write_text("\n".join(_log_lines) + "\n", encoding="utf-8")
        log(f"Log guardado en: {LOG_FILE}")
    except Exception as e:
        log(f"No se pudo guardar el log: {e}", "WARN")


# =============================================================================
# FASE 1: INFORMACIÓN DEL ENTORNO
# =============================================================================
def diagnose_environment():
    log_section("FASE 1: ENTORNO DEL POD")

    # Hostname y IP del pod
    hostname = socket.gethostname()
    log(f"Hostname:        {hostname}")
    try:
        pod_ip = socket.gethostbyname(hostname)
        log(f"Pod IP:          {pod_ip}")
    except socket.gaierror:
        log("Pod IP:          (no se pudo resolver el hostname)", "WARN")

    # Usuario del sistema
    import getpass
    log(f"Usuario:         {getpass.getuser()} (uid={os.getuid()}, gid={os.getgid()})")

    # Variables de entorno relevantes
    env_keys = [
        "SPARK_HOME", "SPARK_CONF_DIR", "JAVA_HOME", "PYTHONPATH",
        "KUBERNETES_SERVICE_HOST", "KUBERNETES_SERVICE_PORT",
        "KUBERNETES_PORT", "HOSTNAME",
    ]
    log("")
    log("Variables de entorno relevantes:")
    for key in env_keys:
        val = os.environ.get(key, "(no definida)")
        log(f"  {key:>30} = {val}")

    # Verificar SPARK_HOME
    spark_home = os.environ.get("SPARK_HOME", "")
    if spark_home:
        conf_dir = Path(spark_home) / "conf"
        log(f"")
        log(f"$SPARK_HOME/conf existe: {conf_dir.exists()}")
        if conf_dir.exists():
            for f in sorted(conf_dir.iterdir()):
                log(f"  -> {f.name} ({f.stat().st_size} bytes)")

    # Verificar SPARK_CONF_DIR personalizado
    spark_conf_dir = os.environ.get("SPARK_CONF_DIR", "")
    if spark_conf_dir:
        p = Path(spark_conf_dir)
        log(f"")
        log(f"$SPARK_CONF_DIR ({spark_conf_dir}) existe: {p.exists()}")
        if p.exists():
            for f in sorted(p.iterdir()):
                log(f"  -> {f.name} ({f.stat().st_size} bytes)")
                if f.name == "spark-defaults.conf":
                    log("  --- Contenido de spark-defaults.conf ---")
                    for line in f.read_text().splitlines():
                        log(f"      {line}")
                    log("  --- Fin ---")

    # ServiceAccount
    log("")
    log(f"SA token existe:     {Path(SA_TOKEN_PATH).exists()}")
    log(f"SA ca.crt existe:    {Path(SA_CA_PATH).exists()}")
    log(f"SA namespace existe: {Path(SA_NS_PATH).exists()}")
    if Path(SA_NS_PATH).exists():
        ns = Path(SA_NS_PATH).read_text().strip()
        log(f"SA namespace valor:  {ns}")


# =============================================================================
# FASE 2: CONECTIVIDAD DE RED
# =============================================================================
def test_tcp(host, port, timeout=5):
    """Intenta una conexión TCP pura. Retorna (ok, latencia_ms, error)."""
    try:
        start = time.monotonic()
        with socket.create_connection((host, port), timeout=timeout):
            elapsed = (time.monotonic() - start) * 1000
            return True, elapsed, None
    except Exception as e:
        return False, 0, str(e)


def test_dns(hostname):
    """Resuelve un hostname. Retorna (ok, ip, error)."""
    try:
        ip = socket.gethostbyname(hostname)
        return True, ip, None
    except socket.gaierror as e:
        return False, None, str(e)


def test_https_api(host, port, timeout=5):
    """Intenta un GET /version al API Server con el token del SA."""
    try:
        token = Path(SA_TOKEN_PATH).read_text().strip()
        url = f"https://{host}:{port}/version"

        # Crear contexto SSL que confíe en la CA del clúster
        ctx = ssl.create_default_context()
        if Path(SA_CA_PATH).exists():
            ctx.load_verify_locations(SA_CA_PATH)
        else:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE

        req = Request(url, headers={"Authorization": f"Bearer {token}"})
        with urlopen(req, timeout=timeout, context=ctx) as resp:
            body = json.loads(resp.read().decode())
            return True, body, None
    except Exception as e:
        return False, None, str(e)


def diagnose_network():
    log_section("FASE 2: CONECTIVIDAD DE RED")

    # DNS
    dns_targets = [
        "kubernetes.default.svc",
        "kubernetes.default.svc.cluster.local",
        "kubernetes.default",
    ]
    log("--- Resolución DNS ---")
    for target in dns_targets:
        ok, ip, err = test_dns(target)
        if ok:
            log(f"  ✅ {target} -> {ip}")
        else:
            log(f"  ❌ {target} -> FALLO: {err}", "ERROR")

    # TCP
    log("")
    log("--- Conectividad TCP ---")
    tcp_results = {}
    for name, _, host, port in MASTER_CANDIDATES:
        ok, ms, err = test_tcp(host, port)
        tcp_results[(host, port)] = ok
        if ok:
            log(f"  ✅ {name:40} ({host}:{port}) -> OK ({ms:.1f}ms)")
        else:
            log(f"  ❌ {name:40} ({host}:{port}) -> FALLO: {err}", "ERROR")

    # HTTPS API (solo para los que pasaron TCP)
    log("")
    log("--- Autenticación HTTPS contra API Server ---")
    if not Path(SA_TOKEN_PATH).exists():
        log("  ⚠️  No hay token de ServiceAccount montado. "
            "¿Estás en el perfil correcto (Comunidad/Profesor)?", "WARN")
    else:
        for name, _, host, port in MASTER_CANDIDATES:
            if not tcp_results.get((host, port)):
                log(f"  ⏭️  {name:40} (saltado, TCP falló)")
                continue
            ok, body, err = test_https_api(host, port)
            if ok:
                ver = body.get("gitVersion", "???")
                log(f"  ✅ {name:40} -> K8s {ver}")
            else:
                log(f"  ❌ {name:40} -> FALLO: {err}", "ERROR")

    # Verificar iptables / kube-proxy (si tenemos acceso)
    log("")
    log("--- Verificación de kube-proxy (iptables) ---")
    try:
        result = subprocess.run(
            ["cat", "/proc/net/ip_conntrack"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            k8s_lines = [l for l in result.stdout.splitlines()
                         if "172.21.0.1" in l or "6443" in l]
            log(f"  Conexiones activas a K8s API: {len(k8s_lines)}")
            for l in k8s_lines[:5]:
                log(f"    {l}")
        else:
            log("  (no se pudo leer conntrack, permisos insuficientes — normal)")
    except Exception:
        log("  (conntrack no disponible — normal en contenedores)")

    return tcp_results


# =============================================================================
# FASE 3: PRUEBA DE SPARK CON MÚLTIPLES CONFIGURACIONES
# =============================================================================
def try_spark_config(name, master, extra_conf=None, timeout=60):
    """
    Intenta crear un SparkSession con la configuración dada.
    Retorna (ok, error_msg, elapsed_seconds).
    """
    log(f"")
    log(f"  🔧 Probando: {name}")
    log(f"     spark.master = {master}")
    if extra_conf:
        for k, v in extra_conf.items():
            log(f"     {k} = {v}")

    try:
        from pyspark.sql import SparkSession

        builder = (
            SparkSession.builder
            .appName(f"KRNEL-Diag-{name[:20]}")
            .master(master)
        )

        # Configuraciones base para K8s
        if master.startswith("k8s://"):
            builder = (
                builder
                .config("spark.kubernetes.namespace", "jupyter")
                .config("spark.kubernetes.authenticate.serviceAccountName",
                        "spark-editor")
                .config("spark.kubernetes.container.image",
                        "quay.io/jupyter/all-spark-notebook:spark-4.1.1")
                .config("spark.executor.instances", "1")
                .config("spark.executor.cores", "1")
                .config("spark.executor.memory", "512m")
                .config("spark.driver.memory", "512m")
            )

            # Token y CA explícitos (por si el automount no basta)
            if Path(SA_TOKEN_PATH).exists():
                builder = builder.config(
                    "spark.kubernetes.authenticate.oauthTokenFile",
                    SA_TOKEN_PATH,
                )
            if Path(SA_CA_PATH).exists():
                builder = builder.config(
                    "spark.kubernetes.authenticate.caCertFile",
                    SA_CA_PATH,
                )

        # Configuraciones extra para este intento
        if extra_conf:
            for k, v in extra_conf.items():
                builder = builder.config(k, v)

        start = time.monotonic()
        spark = builder.getOrCreate()
        elapsed = time.monotonic() - start

        # Prueba rápida: crear un DataFrame trivial
        df = spark.createDataFrame([(1,)], ["x"])
        count = df.count()

        spark.stop()

        log(f"  ✅ ÉXITO en {elapsed:.1f}s (df.count() = {count})")
        return True, None, elapsed

    except Exception as e:
        elapsed = time.monotonic() - start if 'start' in dir() else 0
        full_trace = traceback.format_exc()

        # Extraer solo la causa raíz del stacktrace de Java
        err_str = str(e)
        root_cause = err_str
        for marker in ["Caused by:", "Connection refused", "UnresolvedAddress",
                        "Forbidden", "Unauthorized"]:
            idx = err_str.find(marker)
            if idx >= 0:
                root_cause = err_str[idx:idx + 200]
                break
        log(f"  ❌ FALLO en {elapsed:.1f}s: {root_cause[:200]}", "ERROR")
        log("  --- Traceback completo ---", "ERROR")
        for line in full_trace.splitlines():
            log(f"  {line}", "ERROR")
        log("  --- Fin traceback ---", "ERROR")
        return False, root_cause[:500], elapsed


def diagnose_spark(tcp_results):
    log_section("FASE 3: PRUEBAS DE SPARK SESSION")

    # Determinar la IP del pod para spark.driver.host
    hostname = socket.gethostname()
    try:
        pod_ip = socket.gethostbyname(hostname)
    except socket.gaierror:
        pod_ip = "0.0.0.0"

    # Construir la lista de configuraciones a probar
    configs_to_test = []

    # --- Grupo A: Modo local (siempre debería funcionar) ---
    configs_to_test.append((
        "A1. local[*] (sin K8s)",
        "local[*]",
        None,
    ))

    # --- Grupo B: K8s con distintos endpoints ---
    for cand_name, cand_url, cand_host, cand_port in MASTER_CANDIDATES:
        # Solo probar si TCP pasó (para no esperar timeouts largos)
        if not tcp_results.get((cand_host, cand_port)):
            log(f"  ⏭️  Saltando '{cand_name}' (TCP falló en Fase 2)")
            continue

        # B.x.1: Configuración mínima
        configs_to_test.append((
            f"B. {cand_name} (mínima)",
            cand_url,
            None,
        ))

        # B.x.2: Con driver.host explícito
        configs_to_test.append((
            f"B. {cand_name} + driver.host={pod_ip}",
            cand_url,
            {
                "spark.driver.host": pod_ip,
                "spark.driver.bindAddress": "0.0.0.0",
            },
        ))

        # B.x.3: Con SSL deshabilitado hacia el API
        configs_to_test.append((
            f"B. {cand_name} + sin verificar SSL",
            cand_url,
            {
                "spark.kubernetes.trust.certificates": "true",
            },
        ))

    # --- Grupo C: Modo local con K8s deshabilitado ---
    configs_to_test.append((
        "C1. local[2] explícito",
        "local[2]",
        None,
    ))

    # Ejecutar las pruebas
    results = []
    winner = None

    for name, master, extra in configs_to_test:
        ok, err, elapsed = try_spark_config(name, master, extra)
        results.append((name, master, extra, ok, err, elapsed))
        if ok and winner is None:
            winner = (name, master, extra)

        # Limpiar SparkContext residual entre intentos
        try:
            from pyspark import SparkContext
            sc = SparkContext._active_spark_context
            if sc:
                sc.stop()
        except Exception:
            pass

    # Resumen
    log_section("RESUMEN DE RESULTADOS")

    for name, master, extra, ok, err, elapsed in results:
        status = "✅ ÉXITO" if ok else "❌ FALLO"
        log(f"  {status}  {name}")

    log("")
    if winner:
        wname, wmaster, wextra = winner
        log("🏆 CONFIGURACIÓN GANADORA:")
        log(f"   Nombre: {wname}")
        log(f"   spark.master = {wmaster}")
        if wextra:
            for k, v in wextra.items():
                log(f"   {k} = {v}")
        log("")
        log("Para aplicar esta configuración globalmente, actualiza")
        log("templates/hub-values.yaml.j2 con los valores de arriba y corre:")
        log("  ansible-playbook -i inventories/mrkov \\")
        log("    playbooks/mantenimiento/update-jupyterhub-config.yml -K")
    else:
        log("⚠️  Ninguna configuración de Spark funcionó.", "WARN")
        log("   Revisa los errores de la Fase 2 (red) primero.", "WARN")
        log("   Si TCP falló en TODOS los endpoints, el problema es")
        log("   de red/firewall entre los pods y el API Server.", "WARN")


# =============================================================================
# MAIN
# =============================================================================
if __name__ == "__main__" or True:  # True para que corra en celdas de Jupyter
    log_section("KRNEL — DIAGNÓSTICO DE SPARK")
    log(f"Fecha: {datetime.now().isoformat()}")
    log(f"Python: {sys.version}")

    diagnose_environment()
    tcp_results = diagnose_network()
    diagnose_spark(tcp_results)

    save_log()

    log("")
    log("=" * 72)
    log("  DIAGNÓSTICO COMPLETO")
    log("=" * 72)
