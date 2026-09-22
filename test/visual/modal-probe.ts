import { createApp, h, nextTick, shallowRef } from "vue";
import Confirm from "../../frontend/src/components/Confirm.vue";

/** Mount the real component and unmount it inside Bootstrap's asynchronous transition. */
export async function unmountModal(phase : "opening" | "open" | "closing") : Promise<void> {
    const root = document.createElement("div");
    document.body.append(root);
    const dialog = shallowRef<{ show : () => void } | null>(null);
    const app = createApp({ render: () => h(Confirm, { ref: dialog,
        title: "Lifecycle probe",
        "data-modal-probe": "true" }) });
    app.mount(root);
    await nextTick();
    const modal = root.querySelector<HTMLElement>(".modal")!;
    const shown = new Promise<void>(resolve => modal.addEventListener("shown.bs.modal", () => resolve(), { once: true }));
    dialog.value!.show();
    if (phase !== "opening") {
        await shown;
    }
    if (phase === "closing") {
        modal.querySelector<HTMLButtonElement>(".btn-close")!.click();
    }
    app.unmount();
    root.remove();
}
