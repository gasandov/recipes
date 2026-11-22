import { defineConfig, devices } from "@playwright/test";
import { allPorts, mainPort } from "./e2e/support/ports";

/**
 * Browser tests run against a production build, because the service worker is only registered there.
 * The build goes to a private directory so it never collides with `dist/`, and a small static server
 * with deployment-like headers serves it. See README.md, "Browser tests".
 */
const buildDir = "node_modules/.cache/e2e-dist";

export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.e2e\.ts$/,
  outputDir: "node_modules/.cache/e2e-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  timeout: 45_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: `http://127.0.0.1:${mainPort}`,
    locale: "es-MX",
    timezoneId: "America/Mexico_City",
    serviceWorkers: "allow",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "android-chromium", use: { ...devices["Pixel 7"] } },
    { name: "iphone-webkit", use: { ...devices["iPhone 15"] } },
  ],
  webServer: {
    command: `npm run build:e2e && node e2e/support/server.mjs ${buildDir} ${allPorts.join(" ")}`,
    url: `http://127.0.0.1:${mainPort}/sw.js`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
