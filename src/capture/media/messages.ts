export type MediaFailure =
  | "engine-unavailable"
  | "engine-unsupported"
  | "blocked-source"
  | "cors-or-network"
  | "http-error"
  | "not-image"
  | "too-large"
  | "too-many-pixels"
  | "unreadable"
  | "timeout"
  | "no-text"
  | "aborted";

const pickFile = "Puedes guardar la imagen o tomar una captura y elegirla desde tu dispositivo.";

export const mediaMessages: Record<MediaFailure, string> = {
  "engine-unavailable":
    "No se pudo preparar el lector de imágenes (se descarga una sola vez desde este mismo sitio). Revisa tu conexión e inténtalo de nuevo, o escribe la receta en el editor.",
  "engine-unsupported":
    "Este navegador no puede ejecutar el lector de imágenes. Pega el texto de la receta o abre el editor con el enlace guardado.",
  "blocked-source":
    "Esa imagen está en Instagram o Facebook, o en una dirección que Recetario no abre. " + pickFile,
  "cors-or-network":
    "El sitio no permite que otra app lea esa imagen, o no respondió. No se evita esa protección. " + pickFile,
  "http-error": "El sitio no entregó la imagen. " + pickFile,
  "not-image": "Ese archivo no es una imagen que se pueda leer (usa JPG, PNG, WebP o AVIF).",
  "too-large": "La imagen pesa demasiado (máximo 8 MB). Prueba con una captura más pequeña.",
  "too-many-pixels": "La imagen es demasiado grande para leerla en este dispositivo. Prueba con una captura de pantalla.",
  unreadable: "No se pudo abrir la imagen. Prueba con otra captura.",
  timeout: "Leer la imagen tardó demasiado y se detuvo. Prueba con una imagen más pequeña o con menos texto.",
  "no-text": "No se encontró texto legible. Prueba con una captura más nítida y con la receta bien visible.",
  aborted: "Se canceló la lectura.",
};
