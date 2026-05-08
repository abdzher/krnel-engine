
# KRNEL Engine: Academic PaaS for Distributed Research

**KRNEL Engine** is an Infrastructure-as-Code (IaC) framework based on Ansible, designed to deploy and manage a production-ready **bare-metal K3s cluster** featuring JupyterHub and Apache Spark. It is specifically tailored for the **MRKOV Cluster** (compatibility with different hardware architectures is not fully guaranteed).

> **Status:** 🛠️ *Active Development - Alpha Stage.* This project focuses on solving the gap between hardware resource management and academic research accessibility.

## 🏛️ Architecture & Features

The automated deployment provisions a full-stack environment, including:

* **Network Security:** Firewall configuration via `ufw`.
* **Storage:** Automated NFS server deployment and provisioning for `StorageClasses`.
* **Orchestration:** Multi-node lightweight Kubernetes (**K3s**) deployment.
* **Data Processing:** **Apache Spark** integration (utilizing the `all-spark` JupyterHub image).
* **Observability:** Full monitoring stack with **Grafana** and **Victoria Metrics**.
* **Ingress & Routing:** High-performance routing using **Nginx**.

### 👥 JupyterHub Ecosystem

Within the JupyterHub portal, the platform is pre-configured with:

* **Authentication:** Native auth backed by a user whitelist filter.
* **Role-Based Access Control (RBAC):**
* *Guests:* Ephemeral storage.
* *Students:* Persistent storage.
* *Professors:* Persistent storage + write-access repository for class materials.
* *Admin:* Full administrative privileges.


* **Compute Integration:** Spark pre-configured to utilize cluster resources directly from Jupyter notebooks.
* **Shared Storage:** NFS-backed user repositories, including folders for classes, datasets, and a general-purpose workspace.

---

## ⚙️ Prerequisites

Ensure you have **[uv](https://github.com/astral-sh/uv)** installed, an extremely fast Python package and environment manager.

---

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

3. Copy the resulting encrypted block (starting with `!vault |`) and paste it into your `all.yml` file under the corresponding variables (e.g., `proxy_token` and `jupyterhub_admin_pass`).

---

## 5. Playbook Execution

Once your environment is set up, variables edited, and secrets encrypted, you can proceed to provision the infrastructure. Return to the root of the repository.

To apply the configuration to your nodes, execute the provided playbooks, pointing Ansible to the correct environment (`-i inventories/mrkov`) and adding the `--ask-vault-pass` flag to decrypt your sensitive variables:

```bash
# Example: K3s Base Installation
ansible-playbook -i inventories/mrkov playbooks/01-k3s-install.yml --ask-vault-pass --ask-become-pass

# Example: JupyterHub Deployment
ansible-playbook -i inventories/mrkov playbooks/05-jupyterhub.yml --ask-vault-pass --ask-become-pass

```

**(Ensure you execute the playbooks in the correct numerical order as named in the `playbooks/` directory).**

---

## 🔧 Operations & Troubleshooting

### Webhook Validation Errors

If you receive webhook validation errors during the monitoring playbook execution (e.g., *"Admission webhook 'victoria-metrics-operator.default.svc' rejected the request"*), you must remove the orphaned resource before re-running the playbook:

```bash
ansible-playbook -i inventories/mrkov playbooks/utils/uninstall-monitoring.yml -K

```

### Accessing Grafana

To access Grafana dashboards, retrieve the default `admin` password:

```bash
kubectl get secret --namespace monitoring mrkovmonitor-grafana -o jsonpath="{.data.admin-password}" | base64 --decode ; echo

```

Log in using the `admin` user and the retrieved password at: `http://<node_ip>:<victoria_metrics_port>`

### Accessing JupyterHub

Before general use, log in with the administrator credentials defined in your global variables to initialize the system. Afterward, standard login procedures apply.

### Utilities

Utility playbooks are located in the `playbooks/utils` directory and can be executed similarly to main playbooks:

```bash
# Restart JupyterHub Services
ansible-playbook -i inventories/mrkov playbooks/utils/restart-jupyterhub.yml --ask-become-pass --ask-vault-pass

```

---

## 🧪 Current Engineering Challenges (Known Issues)

As an active project, we are currently addressing the following bottlenecks:

* [ ] **Storage Consistency:** Resolving intermittent persistent storage (PVC) operational inconsistencies.
* [ ] **Session Persistence:** Addressing user access drops in JupyterHub over extended periods.
* [ ] **Spark Resource Allocation:** Stabilizing dynamic resource requests for Spark executors beyond default limits.

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
* [ ] Implementation of a strict GitOps workflow (testing on `develop` branch prior to production deployment).
* [ ] Hardware acceleration integration (**GPU Support**).

### 📦 Upcoming Releases

* [ ] **v0.1.0:** Stable deployment of JupyterHub, Spark, and Grafana stack on bare-metal K3s (pending resolution of known issues).
* [ ] **v0.2.0:** Integration of robust user identity components.
* ...
* [ ] **v1.0.0:** Full production deployment featuring core capabilities and fault-tolerance resilience.
