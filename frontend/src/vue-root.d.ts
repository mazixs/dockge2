import type { DockgeRootApi } from "./root-api";

/**
 * What `$root` is in every component.
 *
 * Vue types the root of an application as "some component", which makes every read of
 * the shared state through `$root` an untyped one: a misspelled field is `undefined` and
 * a template renders it as nothing. Naming the real root here turns that into a
 * compilation error, and nothing changes at runtime - this file only describes.
 */
declare module "vue" {
    interface ComponentCustomProperties {
        $root : DockgeRootApi;
    }
}
