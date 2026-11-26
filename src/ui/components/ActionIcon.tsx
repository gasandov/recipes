import { For } from "solid-js";
import {
  faChevronDown,
  faArrowUpFromBracket,
  faArrowDown,
  faArrowRightFromBracket,
  faArrowRightToBracket,
  faArrowUp,
  faBookOpen,
  faBroom,
  faCamera,
  faCartShopping,
  faCheck,
  faCircleUser,
  faClipboard,
  faCopy,
  faDownload,
  faFilter,
  faFloppyDisk,
  faLink,
  faMicrophone,
  faPenToSquare,
  faPlus,
  faRotateRight,
  faShareNodes,
  faStop,
  faTags,
  faTrashCan,
  faUtensils,
  faVideo,
  faXmark,
  faCarrot,
  faPaperPlane,
} from "@fortawesome/free-solid-svg-icons";

const icons = {
  expand: faChevronDown,
  upload: faArrowUpFromBracket,
  up: faArrowUp,
  down: faArrowDown,
  login: faArrowRightToBracket,
  logout: faArrowRightFromBracket,
  recipes: faBookOpen,
  clear: faBroom,
  image: faCamera,
  shopping: faCartShopping,
  confirm: faCheck,
  account: faCircleUser,
  paste: faClipboard,
  copy: faCopy,
  download: faDownload,
  filter: faFilter,
  save: faFloppyDisk,
  link: faLink,
  microphone: faMicrophone,
  edit: faPenToSquare,
  add: faPlus,
  retry: faRotateRight,
  sync: faRotateRight,
  share: faShareNodes,
  stop: faStop,
  categories: faTags,
  delete: faTrashCan,
  menu: faUtensils,
  video: faVideo,
  close: faXmark,
  ingredients: faCarrot,
  purchase: faCheck,
  send: faPaperPlane,
} as const;

export type ActionIconName = keyof typeof icons;

/** Font Awesome Free artwork is bundled so controls remain available offline. */
export function ActionIcon(props: { name: ActionIconName }) {
  const definition = () => icons[props.name].icon;
  const paths = () => {
    const data = definition()[4];
    return typeof data === "string" ? [data] : data;
  };
  return (
    <svg
      class="action-icon"
      viewBox={`0 0 ${definition()[0]} ${definition()[1]}`}
      aria-hidden="true"
      fill="currentColor"
    >
      <For each={paths()}>{(path) => <path d={path} />}</For>
    </svg>
  );
}
