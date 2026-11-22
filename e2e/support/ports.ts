/** The main server hosts every spec. Each project also gets a private port for the update spec, which changes the served release. */
export const mainPort = 4317;
export const updatePorts = {
  "desktop-chromium": 4318,
  "android-chromium": 4319,
  "iphone-webkit": 4320,
} as const;

export const allPorts = [mainPort, ...Object.values(updatePorts)];
