import { render } from "@solidjs/web";
import { prepareIncomingRecipeShare } from "./capture/share";
import { App } from "./ui/App";

const root = document.getElementById("root");
if (!root) {
  throw new Error("The app root element is missing.");
}

prepareIncomingRecipeShare();
render(() => <App />, root);
