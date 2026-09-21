# Demostración KRNEL/MRKOV

Archivos principales:

- `00_demo_estadistica_mrkov.ipynb`: notebook Python principal para JupyterLab.
- `00_demo_estadistica_mrkov.R`: companion en R con exploracion, `lm()`, `glm()` y bootstrap.
- `datasets/encuesta_bienestar_estudiantil.csv`: dataset sintetico.

El notebook no depende de internet. Si el CSV no existe, lo regenera con semilla fija (`20260522`). El CSV versionado tiene 5,000 filas y es pequeno para Git.

## Uso en JupyterHub

1. Abrir `Clases/00_demo_estadistica_mrkov.ipynb` desde JupyterHub.
2. Copiar el notebook al espacio personal si se desea editarlo.
3. Ejecutar las celdas en orden. La seccion Spark es opcional y usa solamente `master("local[*]")`.
4. Para R, abrir `00_demo_estadistica_mrkov.R` con kernel R.
