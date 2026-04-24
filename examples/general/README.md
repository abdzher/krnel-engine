# Repositorio General de Datos 📂

Esta carpeta está destinada a funcionar como un almacén persistente de solo lectura para **Datasets grandes** y **Modelos pre-entrenados**.

## ¿Por qué usar esta carpeta?
Cuando trabajamos con Big Data, descargar un dataset de 50GB en cada sesión de Jupyter o en cada contenedor de Spark es inviable. 
En su lugar, el administrador del clúster deposita los datasets aquí una sola vez. 

Como esta carpeta está mapeada por NFS a todos los contenedores:
1. **No ocupa espacio extra:** El disco no se llena multiplicando el archivo.
2. **Acceso instantáneo:** Los alumnos pueden cargar el dataset directamente en Spark sin tiempos de descarga.
3. **Seguridad:** Al ser de solo lectura, se evita que el dataset sea modificado o eliminado por error.

*Ejemplo de carga en Spark:*
```python
df = spark.read.csv("/home/jovyan/Repositorio/dataset_gigante.csv")
```
