import type { LocalSupport } from "./environment";
import type { VoiceFailure } from "./controller";

/** User-facing copy in Mexican Spanish. None of it includes dictated content. */
export const failureMessages: Readonly<Record<VoiceFailure, string>> = {
  "cloud-login-required": "Inicia sesión en Cuenta para poder enviar una grabación.",
  denied:
    "No tenemos permiso para usar el micrófono. Permítelo en la configuración del navegador o escribe la receta a mano.",
  "no-microphone": "No encontramos un micrófono disponible. Revisa que esté conectado y que otra app no lo esté usando.",
  "language-unavailable": "Este dispositivo no tiene el paquete de voz en español de México para dictar sin conexión.",
  interrupted: "El dictado se interrumpió.",
  failed: "No pudimos procesar el dictado.",
  empty: "No escuchamos nada. Habla más cerca del micrófono o escribe la receta.",
  unavailable: "La transcripción en la nube no está disponible.",
  "cloud-inactive": "La transcripción en la nube no está activada.",
  "cloud-too-large": "La grabación es demasiado larga para enviarla. Graba una receta más corta.",
  "cloud-unsupported-audio": "El servicio no aceptó el formato de audio de este navegador.",
  "cloud-quota": "Se agotó el límite de transcripción por ahora. Inténtalo más tarde o escribe la receta.",
  "cloud-unavailable": "El servicio de transcripción no está disponible. Inténtalo más tarde.",
  "cloud-rejected": "El servicio no pudo transcribir esta grabación.",
  "cloud-timeout": "El servicio tardó demasiado en responder.",
  "cloud-network": "No pudimos conectarnos al servicio. Revisa tu conexión.",
  "cloud-bad-response": "El servicio respondió algo que no esperábamos.",
};

export function unsupportedMessage(support: Extract<LocalSupport, { kind: "unsupported" }>): string {
  switch (support.reason) {
    case "insecure-context":
      return "El dictado necesita una conexión segura (HTTPS).";
    case "no-microphone-api":
      return "Este navegador no permite usar el micrófono.";
    case "no-local-recognition":
      return "Este navegador no puede reconocer voz dentro del dispositivo. Para cuidar tu privacidad no usamos otro reconocimiento sin tu permiso.";
    case "language-unavailable":
      return "El reconocimiento dentro del dispositivo no tiene español de México disponible aquí.";
    case "check-failed":
      return "No pudimos comprobar si el reconocimiento dentro del dispositivo está disponible.";
  }
}
