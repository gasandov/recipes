import { createUniqueId } from "solid-js";

type Platform = { title: string; note?: string; steps: string[] };

// Menu names follow the wording Spanish-language builds of each browser use. They vary slightly by version,
// so every list says what to look for instead of promising an exact label.
const platforms: readonly Platform[] = [
  {
    title: "iPhone o iPad (Safari)",
    steps: [
      "Abre esta página en Safari.",
      "Toca el botón Compartir, el cuadro con una flecha hacia arriba.",
      "Elige «Agregar a pantalla de inicio» y toca «Agregar».",
      "Abre Recetario desde el ícono nuevo de tu pantalla de inicio.",
    ],
    note: "Si no ves la opción, desliza la lista de acciones hacia abajo o revisa que Safari esté actualizado.",
  },
  {
    title: "Android (Chrome)",
    steps: [
      "Abre esta página en Chrome.",
      "Toca el menú de tres puntos (⋮).",
      "Elige «Instalar app» o «Agregar a la pantalla de inicio» y confirma.",
      "Abre Recetario desde el ícono nuevo de tu pantalla de inicio o de tus apps.",
    ],
    note: "Algunas versiones muestran el nombre «Instalar aplicación».",
  },
  {
    title: "Computadora (Chrome o Edge)",
    steps: [
      "Abre esta página en Chrome o Edge.",
      "Busca el ícono de instalar al final de la barra de direcciones, o abre el menú del navegador y elige «Instalar Recetario».",
      "Confirma con «Instalar». La app se abre en su propia ventana.",
    ],
  },
  {
    title: "Mac (Safari)",
    steps: ["Abre esta página en Safari.", "En el menú Archivo, elige «Agregar al Dock» y confirma."],
    note: "Necesitas una versión reciente de macOS y de Safari. En otros navegadores de escritorio puedes usar Recetario desde una pestaña.",
  },
];

const storagePoints: readonly string[] = [
  "Tus recetas, fotos y menú se guardan solo en este navegador y en este dispositivo. La lista de compras se calcula a partir del menú.",
  "Puedes perder tu recetario si borras los datos del sitio o si el navegador libera almacenamiento. Los datos de una ventana privada pueden desaparecer al cerrarla.",
  "En iPhone y iPad, la app de la pantalla de inicio puede guardar sus datos por separado de Safari. Elige dónde vas a usar Recetario y captura tus recetas ahí.",
];

const offlinePoints: readonly string[] = [
  "Abre Recetario una vez con internet y espera a que cargue por completo. Después podrás abrirlo, ver y editar recetas, cambiar porciones y consultar tu lista de compras sin conexión.",
  "Los enlaces de origen de las recetas solo se abren cuando tienes internet.",
  "Para aplicar una actualización, cierra todas las pestañas de Recetario y la app instalada. Luego vuelve a abrirla. Tus recetas se conservan.",
];

/**
 * Spanish help for adding Recetario to the home screen and for how local storage and offline use work.
 * It is standalone: it needs no app state, so it can be placed in any view.
 */
export function InstallHelp() {
  const id = createUniqueId();

  return (
    <section class="panel install-help" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Instalar y usar sin conexión</h2>
      <p>
        Puedes agregar Recetario a tu pantalla de inicio para abrirlo como una app. Funciona igual desde una pestaña del navegador.
      </p>

      <h3>Cómo instalarla</h3>
      {platforms.map((platform) => (
        <details>
          <summary>{platform.title}</summary>
          <ol>
            {platform.steps.map((step) => (
              <li>{step}</li>
            ))}
          </ol>
          {platform.note ? <p class="hint">{platform.note}</p> : null}
        </details>
      ))}

      <h3>Sin conexión</h3>
      <ul>
        {offlinePoints.map((point) => (
          <li>{point}</li>
        ))}
      </ul>

      <h3>Dónde se guardan tus datos</h3>
      <ul>
        {storagePoints.map((point) => (
          <li>{point}</li>
        ))}
      </ul>
    </section>
  );
}
