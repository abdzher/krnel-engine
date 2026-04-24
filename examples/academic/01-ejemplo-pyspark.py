# =============================================================================
# Ejemplo Básico de PySpark
# =============================================================================
#
# Esta carpeta (Clases/Académica) es de solo lectura para los alumnos, pero
# los profesores tienen permiso de escritura.
# Aquí se colocarán las prácticas, laboratorios y material didáctico.

from pyspark.sql import SparkSession

print("Iniciando sesión de Spark en el clúster MRKOV...")

# La sesión de Spark conectará con el clúster (K3s) automáticamente 
# según la configuración del perfil elegido en JupyterHub.
spark = SparkSession.builder.appName("Ejemplo-Clase").getOrCreate()

print("Sesión creada exitosamente.")

# Crear un DataFrame de prueba
data = [("Alice", 28), ("Bob", 35), ("Charlie", 22)]
df = spark.createDataFrame(data, ["Nombre", "Edad"])

print("\n--- Datos de Ejemplo ---")
df.show()

# Es una buena práctica detener la sesión al finalizar el trabajo
spark.stop()
print("Sesión finalizada.")
