# KRNEL Engine

KRNEL Engine es la infraestructura basada en Ansible para el despliegue y gestión de un clúster K3s bare-metal con JupyterHub y Apache Spark.

## Requisitos Previos

Asegúrate de tener instalado [uv](https://github.com/astral-sh/uv), un gestor de paquetes y entornos de Python extremadamente rápido.

---

## 1. Preparación del Entorno

Primero, crea tu entorno virtual usando `uv` con la versión recomendada de Python (3.12):

```bash
uv venv --python 3.12
```

Activa tu entorno virtual (necesario para usar las dependencias locales):
```bash
source .venv/bin/activate
```

Instala Ansible y la librería requerida (netaddr) en tu sistema utilizando las herramientas de `uv`:

```bash
uv tool install ansible-core --with ansible --with netaddr --force
```

Para asegurarte de que los binarios de Ansible (como `ansible-playbook`, `ansible-galaxy` y `ansible-vault`) estén disponibles en tu `PATH`, ejecuta:

```bash
uv tool update-shell
```

*(Nota: Si `uv` te pide reiniciar tu terminal o cargar de nuevo tu configuración de shell, hazlo antes de continuar).*

---

## 2. Instalación de Dependencias de Ansible

Este proyecto hace uso de colecciones específicas de Ansible. Instálalas usando el archivo de requerimientos:

```bash
# Instalar dependencias y colecciones de Ansible Galaxy
ansible-galaxy install -r requirements.yml
ansible-galaxy collection install -r requirements.yml
```

---

## 3. Configuración del Inventario y Variables

Antes de ejecutar cualquier playbook, necesitas configurar las variables de red y opciones de tu clúster.

1. Navega al directorio de variables globales de tu entorno (ej. `mrkov`):
   ```bash
   cd inventories/mrkov/
   ```
2. Copia el archivo de ejemplo para crear tu configuración real. (El archivo `all.yml` está protegido en `.gitignore` para que no subas tus IPs o secretos accidentalmente):
   ```bash
   cp hosts.example.ini hosts.ini
   cp group_vars/all.example.yml group_vars/all.yml
   ```
3. Edita `all.yml` y reemplaza los valores de ejemplo (como las IPs `X.X.X.X` y los dominios) por los valores reales de tus servidores físicos o máquinas virtuales.

---

## 4. Configuración de Secretos con Ansible Vault

Algunas variables en tu archivo `all.yml` son altamente sensibles, como contraseñas de administrador o tokens. NUNCA las escribas en texto plano. Debes cifrarlas usando `ansible-vault`.

1. Genera las credenciales necesarias, por ejemplo, un token seguro de 32 caracteres para JupyterHub:
   ```bash
   openssl rand -hex 32
   ```

2. Cifra los valores sensibles. Ejecuta este comando e ingresa el valor a cifrar:
   ```bash
   ansible-vault encrypt_string 'TU_VALOR_SECRETO' --name 'nombre_de_la_variable'
   ```
   *(La primera vez que uses ansible-vault te pedirá crear una contraseña maestra para el Vault. ¡Asegúrate de recordarla! La necesitarás al ejecutar los playbooks).*

3. Copia el bloque cifrado resultante (que empieza con `!vault |`) y pégalo dentro de tu archivo `all.yml` en las variables correspondientes (por ejemplo, en `proxy_token` y `jupyterhub_admin_pass`).

---

## 5. Ejecución de los Playbooks

Una vez que tu entorno está listo, las variables editadas y los secretos cifrados, puedes proceder a instalar la infraestructura. Vuelve a la raíz del repositorio.

Para aplicar la configuración a tus nodos, ejecuta los playbooks proporcionados, indicando a Ansible el entorno (`-i inventories/mrkov`) y agregando la bandera `--ask-vault-pass` para que Ansible pueda descifrar tus variables sensibles:

```bash
# Ejemplo: Instalación base de K3s
ansible-playbook -i inventories/mrkov playbooks/01-k3s-install.yml --ask-vault-pass --ask-become-pass

# Ejemplo: Despliegue de JupyterHub
ansible-playbook -i inventories/mrkov playbooks/05-jupyterhub.yml --ask-vault-pass --ask-become-pass
```

**(Asegúrate de ejecutar los playbooks en el orden numérico correcto según estén nombrados en la carpeta `playbooks/`).**
