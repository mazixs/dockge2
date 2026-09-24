// Dayjs init inside this, so it has to be the first import
import "../../common/util-common";

import { createApp } from "vue";
import { router } from "./router";
import { FontAwesomeIcon } from "./icon.js";
import { i18n } from "./i18n";
import { ellipsisTitle } from "./directives/ellipsis-title";
import { rootApp } from "./root";

// Dependencies
import "bootstrap/js/dist/dropdown";
import Vue3Toastify, { toast } from "vue3-toastify";

// CSS
import "vue3-toastify/dist/index.css";
import "./styles/main.scss";

// Set Title
document.title = document.title + " - " + location.host;

const app = createApp(rootApp());

// No containerClassName "toast-container": Bootstrap owns that class and makes the
// container absolute and click-through, so a sliding toast widened the page
app.use(Vue3Toastify, {
    position: toast.POSITION.BOTTOM_RIGHT,
    closeButton: true,
});
app.use(router);
app.use(i18n);
app.component("FontAwesomeIcon", FontAwesomeIcon);
app.directive("ellipsis-title", ellipsisTitle);
app.mount("#app");
