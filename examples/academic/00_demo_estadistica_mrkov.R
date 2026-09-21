# MRKOV/KRNEL: Estadistica aplicada desde una plataforma academica
# Companion R para examples/academic/00_demo_estadistica_mrkov.ipynb
# Dataset sintetico: datasets/encuesta_bienestar_estudiantil.csv en Clases,
# o examples/academic/datasets/encuesta_bienestar_estudiantil.csv en el repo.

set.seed(20260522)

packages <- c("tidyverse", "broom", "boot")
missing <- packages[!vapply(packages, requireNamespace, logical(1), quietly = TRUE)]
if (length(missing) > 0) {
  stop("Faltan paquetes de R: ", paste(missing, collapse = ", "),
       ". Instala estos paquetes o ejecuta la seccion Python principal.")
}

library(tidyverse)
library(broom)
library(boot)

find_repo_root <- function(start = getwd()) {
  current <- normalizePath(start, mustWork = TRUE)
  repeat {
    if (dir.exists(file.path(current, "examples")) && dir.exists(file.path(current, "playbooks"))) {
      return(current)
    }
    parent <- dirname(current)
    if (identical(parent, current)) return(normalizePath(start, mustWork = TRUE))
    current <- parent
  }
}

root <- find_repo_root()
data_file <- "encuesta_bienestar_estudiantil.csv"
data_candidates <- c(
  file.path(getwd(), "datasets", data_file),
  file.path(dirname(getwd()), "datasets", data_file),
  file.path(root, "examples", "academic", "datasets", data_file),
  file.path(root, "examples", "datasets", data_file)
)
existing_data <- data_candidates[file.exists(data_candidates)]
data_path <- if (length(existing_data) > 0) existing_data[[1]] else data_candidates[[1]]
if (!file.exists(data_path)) {
  stop("No existe el CSV esperado: ", data_path,
       "\nEjecuta primero el notebook Python o siembra examples/academic con el playbook de ejemplos.")
}

datos <- readr::read_csv(data_path, show_col_types = FALSE)
cat("Filas:", nrow(datos), " Columnas:", ncol(datos), "\n")
print(dplyr::glimpse(datos))

plot_estudio <- ggplot(datos, aes(horas_estudio, calificacion_final, color = carrera)) +
  geom_point(alpha = 0.20, size = 1.4) +
  geom_smooth(method = "loess", se = FALSE, linewidth = 1.1) +
  scale_color_brewer(palette = "Dark2") +
  labs(title = "Horas de estudio y calificacion final",
       subtitle = "Relacion positiva con variabilidad por carrera",
       x = "Horas de estudio por semana", y = "Calificacion final", color = "Carrera") +
  theme_minimal(base_size = 13)
print(plot_estudio)

plot_box <- datos |>
  mutate(carrera = fct_reorder(carrera, calificacion_final, .fun = median)) |>
  ggplot(aes(carrera, calificacion_final, fill = carrera)) +
  geom_boxplot(alpha = 0.85, outlier.alpha = 0.18) +
  coord_flip() +
  guides(fill = "none") +
  labs(title = "Distribucion de calificacion final por carrera", x = NULL, y = "Calificacion final") +
  theme_minimal(base_size = 13)
print(plot_box)

modelo_lm <- lm(
  calificacion_final ~ horas_estudio + asistencia_pct + horas_sueno + I(horas_sueno^2) +
    estres_escala + promedio_previo + trabaja + carrera + factor(semestre),
  data = datos
)
cat("
Regresion lineal: coeficientes principales
")
print(tidy(modelo_lm, conf.int = TRUE) |>
        filter(term %in% c("horas_estudio", "asistencia_pct", "horas_sueno", "I(horas_sueno^2)", "estres_escala", "promedio_previo", "trabaja")) |>
        select(term, estimate, conf.low, conf.high, p.value))
print(glance(modelo_lm) |> select(r.squared, adj.r.squared, sigma, AIC, BIC))

modelo_glm <- glm(
  aprobacion ~ horas_estudio + asistencia_pct + horas_sueno + estres_escala +
    promedio_previo + trabaja + carrera,
  data = datos,
  family = binomial()
)
cat("
Regresion logistica: odds ratios
")
print(tidy(modelo_glm, exponentiate = TRUE, conf.int = TRUE) |>
        filter(term %in% c("horas_estudio", "asistencia_pct", "horas_sueno", "estres_escala", "promedio_previo", "trabaja")) |>
        select(term, estimate, conf.low, conf.high, p.value))

datos_prob <- datos |> mutate(prob_aprobar = predict(modelo_glm, type = "response"))
plot_prob <- ggplot(datos_prob, aes(prob_aprobar, fill = factor(aprobacion))) +
  geom_histogram(position = "identity", alpha = 0.55, bins = 35) +
  scale_fill_manual(values = c("#bc4749", "#31572c"), labels = c("No aprueba", "Aprueba")) +
  labs(title = "Probabilidades estimadas de aprobar", x = "Probabilidad estimada", y = "Numero de estudiantes", fill = "Resultado") +
  theme_minimal(base_size = 13)
print(plot_prob)

media_stat <- function(data, indices) mean(data[indices])
boot_media <- boot(datos$calificacion_final, statistic = media_stat, R = 1500)
ci <- boot.ci(boot_media, type = "perc")
cat("
Media observada:", mean(datos$calificacion_final), "
")
print(ci)

boot_tbl <- tibble(media_bootstrap = boot_media$t[, 1])
plot_boot <- ggplot(boot_tbl, aes(media_bootstrap)) +
  geom_histogram(bins = 38, fill = "#90a955", color = "white") +
  geom_vline(xintercept = mean(datos$calificacion_final), color = "#132a13", linewidth = 1.2) +
  labs(title = "Distribucion bootstrap de la media de calificacion final", x = "Media bootstrap", y = "Frecuencia") +
  theme_minimal(base_size = 13)
print(plot_boot)
