import { createContext, createMemo, createSignal, onSettled } from "solid-js";
import type { Accessor } from "solid-js";
import type {
  Category, Ingredient, Library, MenuEntry, PhotoInput, Recipe, RecipeDraft, RecipeFilters,
} from "../contracts";
import { repository } from "../data/repository";

export type LoadStatus = "loading" | "ready" | "error";
export type Outcome<T> = { ok: true; value: T } | { ok: false };
export type Notice = { id: number; kind: "success" | "error"; text: string };
export type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  resolve: (accepted: boolean) => void;
};

export const emptyFilters: RecipeFilters = {
  query: "",
  dishTypeIds: [],
  cuisineIds: [],
  tagIds: [],
  ingredientIds: [],
};

const emptyLibrary: Library = { recipes: [], categories: [], ingredients: [] };

export type AppState = {
  status: Accessor<LoadStatus>;
  library: Accessor<Library>;
  /** The latest loaded library, read without tracking. Use it to seed a form once. */
  snapshot: () => Library;
  ingredientsById: Accessor<Map<string, Ingredient>>;
  categoriesById: Accessor<Map<string, Category>>;
  menu: Accessor<MenuEntry[]>;
  reload: () => Promise<boolean>;
  saveRecipe: (draft: RecipeDraft, photo?: PhotoInput | null) => Promise<Outcome<Recipe>>;
  deleteRecipe: (id: string) => Promise<boolean>;
  saveCategory: (draft: Omit<Category, "id"> & { id?: string }) => Promise<Outcome<Category>>;
  deleteCategory: (id: string) => Promise<boolean>;
  saveIngredient: (draft: Omit<Ingredient, "id"> & { id?: string }) => Promise<Outcome<Ingredient>>;
  deleteIngredient: (id: string) => Promise<boolean>;
  addMenuBatch: (recipeId: string) => Promise<boolean>;
  setMenuBatchPortions: (id: string, portions: number) => Promise<boolean>;
  removeMenuBatch: (id: string) => Promise<boolean>;
  clearActiveMenu: () => Promise<boolean>;
  filters: Accessor<RecipeFilters>;
  setFilters: (next: RecipeFilters) => void;
  notices: Accessor<Notice[]>;
  notify: (kind: Notice["kind"], text: string) => void;
  dismissNotice: (id: number) => void;
  pendingConfirm: Accessor<ConfirmRequest | undefined>;
  confirm: (request: Omit<ConfirmRequest, "resolve">) => Promise<boolean>;
  settleConfirm: (accepted: boolean) => void;
};

export const AppContext = createContext<AppState>();

let noticeId = 0;

/** Creates the application state. Must be called from a component body. */
export function createAppState(): AppState {
  const [status, setStatus] = createSignal<LoadStatus>("loading");
  const [library, setLibrary] = createSignal<Library>(emptyLibrary);
  const [menu, setMenu] = createSignal<MenuEntry[]>([]);
  let latestLibrary = emptyLibrary;
  let menuQueue = Promise.resolve();
  let menuChannel: BroadcastChannel | undefined;
  const [filters, setFilters] = createSignal<RecipeFilters>(emptyFilters);
  const [notices, setNotices] = createSignal<Notice[]>([]);
  const [pendingConfirm, setPendingConfirm] = createSignal<ConfirmRequest | undefined>(undefined);

  const ingredientsById = createMemo(() => new Map(library().ingredients.map((item) => [item.id, item])));
  const categoriesById = createMemo(() => new Map(library().categories.map((item) => [item.id, item])));

  const dismissNotice = (id: number) => setNotices((current) => current.filter((notice) => notice.id !== id));

  const notify = (kind: Notice["kind"], text: string) => {
    const id = ++noticeId;
    setNotices((current) => [...current, { id, kind, text }]);
    if (kind === "success") setTimeout(() => dismissNotice(id), 6000);
  };

  function updateMenu(operation: () => Promise<MenuEntry[]>, publish = false): Promise<boolean> {
    // Apply reads and committed writes in order, including refreshes from other tabs.
    const next = menuQueue.then(async () => {
      try {
        setMenu(await operation());
      } catch (error) {
        console.error("Could not update the active menu.", error);
        return false;
      }
      if (publish) menuChannel?.postMessage("updated");
      return true;
    });
    menuQueue = next.then(() => {});
    return next;
  }

  async function reloadLibrary(): Promise<boolean> {
    try {
      latestLibrary = await repository.getLibrary();
      setLibrary(latestLibrary);
      return true;
    } catch (error) {
      console.error("Could not load the recipe library.", error);
      return false;
    }
  }

  async function reload(): Promise<boolean> {
    const [libraryLoaded, menuLoaded] = await Promise.all([
      reloadLibrary(),
      updateMenu(repository.getActiveMenu),
    ]);
    const loaded = libraryLoaded && menuLoaded;
    if (loaded) setStatus("ready");
    // Keep showing the last known data when a refresh fails after the first load.
    else if (status() !== "ready") setStatus("error");
    return loaded;
  }

  /** Runs a write, logs the original error, and refreshes the library after a success. */
  async function write<T>(operation: () => Promise<T>): Promise<Outcome<T>> {
    let value: T;
    try {
      value = await operation();
    } catch (error) {
      console.error("A repository write failed.", error);
      return { ok: false };
    }
    if (!(await reloadLibrary())) {
      notify("error", "Se guardó el cambio, pero no pudimos actualizar la pantalla. Recarga la página.");
    }
    return { ok: true, value };
  }

  const succeeded = async (operation: () => Promise<unknown>) => (await write(operation)).ok;

  onSettled(() => {
    if (typeof BroadcastChannel !== "undefined") {
      menuChannel = new BroadcastChannel("recetario-menu");
      menuChannel.onmessage = () => void updateMenu(repository.getActiveMenu);
    }
    void reload();
    return () => {
      menuChannel?.close();
      menuChannel = undefined;
    };
  });

  return {
    status,
    library,
    snapshot: () => latestLibrary,
    ingredientsById,
    categoriesById,
    menu,
    reload,
    saveRecipe: (draft, photo) => write(() => repository.saveRecipe(draft, photo)),
    deleteRecipe: (id) => succeeded(() => repository.deleteRecipe(id)),
    saveCategory: (draft) => write(() => repository.saveCategory(draft)),
    deleteCategory: (id) => succeeded(() => repository.deleteCategory(id)),
    saveIngredient: (draft) => write(() => repository.saveIngredient(draft)),
    deleteIngredient: (id) => succeeded(() => repository.deleteIngredient(id)),
    addMenuBatch: (recipeId) => updateMenu(() => repository.addMenuBatch(recipeId), true),
    setMenuBatchPortions: (id, portions) => updateMenu(() => repository.setMenuBatchPortions(id, portions), true),
    removeMenuBatch: (id) => updateMenu(() => repository.removeMenuBatch(id), true),
    clearActiveMenu: () => updateMenu(repository.clearActiveMenu, true),
    filters,
    setFilters: (next) => setFilters(next),
    notices,
    notify,
    dismissNotice,
    pendingConfirm,
    confirm: (request) =>
      new Promise<boolean>((resolve) => setPendingConfirm({ ...request, resolve })),
    settleConfirm: (accepted) => {
      const request = pendingConfirm();
      setPendingConfirm(undefined);
      request?.resolve(accepted);
    },
  };
}
