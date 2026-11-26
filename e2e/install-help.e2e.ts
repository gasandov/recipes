import { expect, press, test } from "./support/app";

test("installation and local storage help is available in Spanish", async ({ app, page }) => {
  await app.open();
  await press(page.locator("summary").filter({ hasText: "Ayuda de instalación y almacenamiento" }));
  await expect(page.getByRole("heading", { name: "Instalar y usar sin conexión" })).toBeVisible();

  const help = page.locator("section.install-help");
  for (const platform of ["iPhone o iPad (Safari)", "Android (Chrome)", "Computadora (Chrome o Edge)", "Mac (Safari)"]) {
    await press(help.locator("summary").filter({ hasText: platform }));
  }
  await expect(help).toContainText("Agregar a pantalla de inicio");
  await expect(help).toContainText("Instalar app");
  await expect(help).toContainText("Agregar al Dock");
  await expect(help).toContainText("solo en este navegador y en este dispositivo");
  await expect(help).toContainText("Abre Recetario una vez con internet");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});
