
# KRNEL Engine: Academic PaaS for Distributed Research

**KRNEL Engine** is an Infrastructure-as-Code (IaC) framework based on Ansible, designed to deploy and manage a production-ready **bare-metal K3s cluster** featuring JupyterHub and Apache Spark. It is specifically tailored for the **MRKOV Cluster** (compatibility with different hardware architectures is not fully guaranteed for now).

> **Status:** 🛠️ *Active Development - Alpha Stage.* This project focuses on solving the gap between hardware resource management and academic research accessibility.

## 🏛️ Architecture & Features

The automated deployment provisions a full-stack environment, including:

* **Network Security:** Firewall configuration via `ufw`.
* **Storage:** **Longhorn** distributed block storage as the default `StorageClass`; legacy NFS playbooks are kept only under `playbooks/old/`.
* **Orchestration:** Multi-node lightweight Kubernetes (**K3s**) deployment.
* **Data Processing:** **Apache Spark** integration (utilizing the `all-spark` JupyterHub image).
* **Observability:** Full monitoring stack with **Grafana** and **Victoria Metrics**.
* **Ingress & Routing:** K3s/Traefik routing for public services and local-only NodePort access for administrative panels.

### 👥 JupyterHub Ecosystem

Within the JupyterHub portal, the platform is pre-configured with:

* **Authentication:** NativeAuthenticator with an allowlist-driven admission flow.
* **Role-Based Access Control (RBAC):** guests use ephemeral storage; students, professors, and admins use persistent profiles with different resource and shared-folder access policies.
* **Compute Integration:** Spark on Kubernetes pre-configured to launch executor pods from Jupyter notebooks.
* **Shared Storage:** Longhorn-backed shared PVCs for `Clases`, `Comunidad`, and `Repositorio`.

---

## ⚙️ Prerequisites

Ensure you have **[uv](https://github.com/astral-sh/uv)** installed, an extremely fast Python package and environment manager.

---
<!--
## 0. Infrastructure

This repository is specifically tailored for the **MRKOV Cluster**; however, you can try deploying it if your infrastructure is similar:

   - More than 3 x86_64 desktop computers connected via LAN, preferably on the same switch.
   - One master node.

---
-->
## 1. Environment Setup

First, create your virtual environment using `uv` with the recommended Python version (3.12):

```bash
uv venv --python 3.12

```

Activate the virtual environment (required to use local dependencies):

```bash
source .venv/bin/activate

```

Install Ansible and the required library (`netaddr`) on your system using `uv` tools:

```bash
uv tool install ansible-core --with ansible --with netaddr --force

```

To ensure Ansible binaries (such as `ansible-playbook`, `ansible-galaxy`, and `ansible-vault`) are available in your `PATH`, run:

```bash
uv tool update-shell

```

*(Note: If `uv` prompts you to restart your terminal or reload your shell configuration, do so before proceeding).*

---

## 2. Ansible Dependencies Installation

This project relies on specific Ansible collections. Install them using the requirements file:

```bash
# Install dependencies and Ansible Galaxy collections
ansible-galaxy install -r requirements.yml
ansible-galaxy collection install -r requirements.yml

```

---

## 3. Inventory and Variables Configuration

Before executing any playbook, you must configure your network variables and cluster options.

1. Navigate to your environment's global variables directory (e.g., `mrkov`):
```bash
cd inventories/mrkov/

```


2. Copy the template files to create your actual configuration. (The `all.yml` file is protected in `.gitignore` to prevent accidental commits of IPs or secrets):

```bash
   cp hosts.example.ini hosts.ini
   cp group_vars/all.example.yml group_vars/all.yml

```

3. Edit `all.yml` and replace the placeholder values (such as `X.X.X.X` IPs and domains) with the actual values of your bare-metal servers or VMs.

---

## 4. Secrets Management with Ansible Vault

Certain variables in your `all.yml` file are highly sensitive (e.g., admin passwords or API tokens). NEVER store them in plain text. You must encrypt them using `ansible-vault`.

1. Generate the necessary credentials. For example, a secure 32-character token for JupyterHub:
```bash
openssl rand -hex 32

```


2. Encrypt the sensitive values. Run the following command and input the value to encrypt:

```bash
   ansible-vault encrypt_string 'YOUR_SECRET_VALUE' --name 'variable_name'

```

*(The first time you use ansible-vault, it will prompt you to create a master password. Make sure to remember it, as you will need it to run the playbooks).*

3. Copy the resulting encrypted block (starting with `!vault |`) and paste it into your `all.yml` file under `proxy_token`. With NativeAuthenticator, the admin user signs up once with the username configured in `jupyterhub_admin_user`.

---

## 5. Playbook Execution

Once your environment is set up, variables edited, and secrets encrypted, you can proceed to provision the infrastructure. Return to the root of the repository.

To apply the configuration to your nodes, execute the provided playbooks, pointing Ansible to the correct environment (`-i inventories/mrkov`) and adding the `--ask-vault-pass` flag to decrypt your sensitive variables:

```bash
# Example: K3s Base Installation
ansible-playbook -i inventories/mrkov playbooks/01-k3s-install.yml --ask-vault-pass --ask-become-pass

# Example: Longhorn Storage
ansible-playbook -i inventories/mrkov playbooks/03-longhorn.yml --ask-vault-pass --ask-become-pass

# Example: JupyterHub Deployment
ansible-playbook -i inventories/mrkov playbooks/05-jupyterhub.yml --ask-vault-pass --ask-become-pass

```

**(Ensure you execute the playbooks in the correct numerical order as named in the `playbooks/` directory).**

Current main sequence:

```text
00-system-prep.yml
01-k3s-install.yml
02-helm-certmgr.yml
03-longhorn.yml
04-monitoring.yml
05-jupyterhub.yml
06-landing-page.yml
```

For a full run, use:

```bash
ansible-playbook -i inventories/mrkov playbooks/site.yml --ask-vault-pass --ask-become-pass
```

---

## 🔧 Operations & Troubleshooting

### Webhook Validation Errors

If you receive webhook validation errors during the monitoring playbook execution (e.g., *"Admission webhook 'victoria-metrics-operator.default.svc' rejected the request"*), you must remove the orphaned resource before re-running the playbook:

```bash
ansible-playbook -i inventories/mrkov playbooks/utils/uninstall-monitoring.yml -K

```


### Accessing Longhorn Panel

Create SSH tunnel:

```bash
ssh -L 30090:localhost:30090 ansible@nd-1

```

Then open `http://localhost:30090` in your browser.


### Accessing Grafana

To access Grafana dashboards, retrieve the default `admin` password:

```bash
kubectl get secret --namespace monitoring mrkovmonitor-grafana -o jsonpath="{.data.admin-password}" | base64 --decode ; echo

```

Log in using the `admin` user and the retrieved password. In the MRKOV routing layout, monitoring is exposed under the MRKOV portal domain (for example, `https://mrkov.abdz.dev/grafana/`).

### Accessing JupyterHub

JupyterHub is exposed as the primary app for the configured Jupyter domain (for example, `https://jupyter.abdz.dev/`). With NativeAuthenticator, the administrator account must sign up once using the username configured in `jupyterhub_admin_user`; afterward, standard login procedures apply.

### Utilities

Utility playbooks are located in the `playbooks/utils` directory and can be executed similarly to main playbooks:

```bash
# Re-apply JupyterHub configuration only
ansible-playbook -i inventories/mrkov playbooks/05-jupyterhub.yml --tags update --ask-become-pass --ask-vault-pass

# Seed example notebooks/files into the Longhorn shared PVCs
ansible-playbook -i inventories/mrkov playbooks/utils/seed-examples.yml --ask-become-pass --ask-vault-pass

# Diagnose Spark/Kubernetes executor infrastructure
ansible-playbook -i inventories/mrkov playbooks/utils/diagnose-spark-infra.yml --ask-become-pass --ask-vault-pass

```

---

## 🧪 Current Engineering Challenges (Known Issues)

As an active project, we are currently addressing the following bottlenecks:

* [ ] **Content Governance:** Evaluate a dedicated content-management service (for example File Browser) so shared folders can stay read-only inside JupyterHub.
* [ ] **Identity at Scale:** Evaluate OIDC/LDAP integration, preferably Microsoft Entra if institutional approval becomes available.
* [ ] **Spark Resource Profiles:** Continue tuning demo and production Spark executor presets for classroom workloads.

---

## 🗺️ Roadmap & Future Implementations

* [ ] Custom identity components (custom `krnel` command and JupyterHub template).
* [ ] Implementation of power outage resilience mechanisms.
* [ ] Automated cluster backup routines.
* [ ] Ansible testing playbooks for pre-flight validation.
* [ ] Enhanced example notebooks for the user repository.
* [ ] Migration from SQLite to **PostgreSQL** for JupyterHub state management.
* [ ] Deployment of PostgreSQL as an internal cluster service for users.
* [ ] Integration of **MinIO** for S3-compatible object storage.
* [ ] Optional File Browser/Nextcloud-style content portal for professor-managed course materials and datasets.
* [ ] Implementation of a strict GitOps workflow (testing on `develop` branch prior to production deployment).
* [ ] Hardware acceleration integration (**GPU Support**).

### 📦 Upcoming Releases

* [ ] **v0.1.0:** Stable deployment of JupyterHub, Spark, and Grafana stack on bare-metal K3s (pending resolution of known issues).
* [ ] **v0.2.0:** Integration of robust user identity components.
* ...
* [ ] **v1.0.0:** Full production deployment featuring core capabilities and fault-tolerance resilience.
