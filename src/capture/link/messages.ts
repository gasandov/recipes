import type { ImportErrorCode } from "../../../supabase/functions/import-recipe/protocol.ts";

export type LinkFailure =
  | ImportErrorCode
  | "invalid-link"
  | "unsupported-social"
  | "not-configured"
  | "sign-in-required"
  | "offline"
  | "network"
  | "bad-response"
  | "no-recipe-data";

export const failureMessages: Record<LinkFailure, string> = {
  "invalid-link": "Ese enlace no parece válido. Revisa que empiece con https:// y vuelve a intentarlo.",
  "unsupported-social":
    "Instagram y Facebook no permiten leer las descripciones ni los videos de otras personas desde una app externa. " +
    "Puedes pegar el texto de la descripción o abrir el editor con el enlace guardado.",
  "not-configured": "La importación automática no está configurada en esta instalación. Puedes abrir el editor con el enlace guardado.",
  "sign-in-required": "Necesitas iniciar sesión para usar la importación automática. Puedes abrir el editor con el enlace guardado.",
  offline: "No hay conexión. Conéctate para importar o abre el editor con el enlace guardado.",
  network: "No se pudo contactar el servicio de importación. Inténtalo de nuevo o abre el editor con el enlace guardado.",
  "bad-response": "El servicio de importación respondió algo inesperado. Abre el editor con el enlace guardado.",
  "no-recipe-data":
    "La página abrió, pero no encontramos una receta que podamos leer. Algunas páginas cargan la receta con JavaScript o la ocultan. " +
    "Puedes pegar el texto de la receta o abrir el editor con el enlace guardado.",
  bad_request: "No se pudo enviar el enlace. Revísalo e inténtalo de nuevo.",
  invalid_url: "Ese enlace no parece válido. Revisa que empiece con https:// y vuelve a intentarlo.",
  unsafe_destination: "Por seguridad solo se importan páginas públicas con https://. Ese enlace no se puede abrir desde el servicio.",
  unsupported_source:
    "Instagram y Facebook no permiten leer las descripciones ni los videos de otras personas desde una app externa. " +
    "Puedes pegar el texto de la descripción o abrir el editor con el enlace guardado.",
  not_allowed: "Esta instalación no tiene permitido importar desde ese sitio. Puedes abrir el editor con el enlace guardado.",
  unauthorized: "Necesitas iniciar sesión para usar la importación automática. Puedes abrir el editor con el enlace guardado.",
  forbidden_origin: "Esta instalación no está autorizada para usar el servicio de importación.",
  not_configured: "La importación automática no está configurada en el servicio. Puedes abrir el editor con el enlace guardado.",
  rate_limited: "Hiciste muchas importaciones en poco tiempo. Espera un minuto e inténtalo de nuevo.",
  inaccessible: "La página no es pública o no permitió leerla (requiere iniciar sesión, está bloqueada o ya no existe). Abre el editor con el enlace guardado.",
  busy: "El sitio pidió esperar antes de más solicitudes. Inténtalo de nuevo en unos minutos.",
  upstream_error: "El sitio tuvo un problema al responder. Inténtalo más tarde o abre el editor con el enlace guardado.",
  too_many_redirects: "El enlace redirige demasiadas veces. Abre la página, copia el enlace final e inténtalo de nuevo.",
  timeout: "El sitio tardó demasiado en responder. Inténtalo de nuevo o abre el editor con el enlace guardado.",
  too_large: "La página es demasiado grande para importarla. Abre el editor con el enlace guardado.",
  not_html: "El enlace no apunta a una página web con receta (puede ser un archivo, imagen o video). Abre el editor con el enlace guardado.",
};
