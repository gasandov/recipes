import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "public/ocr/**", "supabase/.temp/**", "supabase/.branches/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    rules: { "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }] },
  },
  {
    files: ["src/pwa/service-worker.js"],
    languageOptions: {
      globals: { self: "readonly", caches: "readonly", fetch: "readonly", Request: "readonly", URL: "readonly" },
    },
  },
);
