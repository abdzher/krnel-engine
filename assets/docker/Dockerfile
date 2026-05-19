ARG BASE_IMAGE=quay.io/jupyter/all-spark-notebook:spark-4.1.1
FROM ${BASE_IMAGE}

USER root

COPY conda-packages.txt /tmp/conda-packages.txt
COPY requirements.txt /tmp/requirements.txt

RUN mamba install -y -c conda-forge --file /tmp/conda-packages.txt \
    && mamba clean -afy \
    && python -m pip install --no-cache-dir \
      -r /tmp/requirements.txt \
      jupyterlab-language-pack-es-ES \
    && rm -f /tmp/conda-packages.txt /tmp/requirements.txt \
    && fix-permissions "${CONDA_DIR}" \
    && fix-permissions "/home/${NB_USER}"

USER ${NB_UID}
