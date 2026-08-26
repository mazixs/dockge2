import type { ComponentPublicInstance } from "vue";

/**
 * Compatibility alias required by vue-i18n 11.4 with Vue 3.5 type exports.
 */
declare module "vue" {
    export type GenericComponentInstance = ComponentPublicInstance;
}
