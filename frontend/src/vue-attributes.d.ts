/**
 * Attributes a template may put on anything.
 *
 * With strict templates on, Vue only accepts what a component or an element declares,
 * which is the point: a misspelled prop has to fail. ARIA and `data-` attributes are not
 * props though - they are part of HTML, a component passes them on unchanged, and every
 * accessible control here needs them. They are allowed by shape, so `aria-pressed` and
 * `data-bs-dismiss` pass while an unknown prop still does not.
 */
declare module "vue" {
    interface HTMLAttributes {
        [key : `data-${string}`] : unknown;
    }

    /**
     * Directives every template may use.
     *
     * They are registered on the application in `main.ts`, so no component imports them
     * and a strict template would otherwise be told they do not exist.
     */
    interface GlobalDirectives {
        vEllipsisTitle : import("vue").Directive<HTMLElement>;
    }

    /**
     * Components registered on the application by hand in `main.ts`.
     *
     * The generated list only knows the ones the plugin finds by file name, so an
     * icon used in every template would otherwise be an unknown component.
     */
    interface GlobalComponents {
        FontAwesomeIcon : typeof import("./icon").FontAwesomeIcon;
    }

    interface ComponentCustomProps {
        [key : `aria-${string}`] : unknown;
        [key : `data-${string}`] : unknown;
        // Global HTML attributes a component hands down to the element it renders.
        // They belong to every element, so a component that forwards them declares
        // nothing, and the template would otherwise be told they do not exist
        title? : string;
        id? : string;
        role? : string;
        tabindex? : number | string;
        hidden? : boolean;
    }
}

export {};

/**
 * The neutral button of this panel.
 *
 * `btn-normal` is defined in the design tokens and used everywhere a button must not
 * shout. The library only knows the Bootstrap palette, so the variant is named here
 * instead of being passed as a string the checker has to be talked out of.
 */
declare module "bootstrap-vue-next" {
    interface BaseButtonVariant {
        normal : unknown;
    }
}
