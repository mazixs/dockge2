import type { Directive } from "vue";

/**
 * Подсказка на обрезанном тексте.
 *
 * Обрезка многоточием сама по себе честна - она говорит, что текст длиннее места, -
 * но не говорит, что именно спрятано. Директива вешает `title` ровно тогда, когда
 * текст действительно не помещается, и снимает его, когда места снова хватает:
 * подсказка с тем же текстом, что и на экране, - шум.
 *
 * Читающим с экрана она ничего не должна: полное имя стоит в `aria-label` ссылки.
 * На касании наведения нет, поэтому полное имя всегда доступно и внутри экрана.
 */

const observers = new WeakMap<HTMLElement, ResizeObserver>();

/**
 * Поставить или снять подсказку по текущей ширине
 * @param {HTMLElement} el Элемент с обрезкой
 * @returns {void}
 */
function sync(el : HTMLElement) : void {
    // Единица допуска: подпиксельная ширина шрифта дает scrollWidth на доли больше
    const cut = el.scrollWidth > el.clientWidth + 1;
    // Именно innerText, а не textContent: он не берет то, что скрыто CSS. На
    // телефоне часть подписи убирается медиа-запросом, и подсказка обещала бы текст,
    // которого на экране нет
    const text = el.innerText.trim();

    if (cut && text !== "") {
        el.setAttribute("title", text);
    } else {
        el.removeAttribute("title");
    }
}

export const ellipsisTitle : Directive<HTMLElement> = {
    mounted(el) {
        sync(el);

        // Ширина меняется без перерисовки: боковой список сжимается вместе с окном
        const observer = new ResizeObserver(() => sync(el));
        observer.observe(el);
        observers.set(el, observer);
    },

    updated(el) {
        sync(el);
    },

    unmounted(el) {
        observers.get(el)?.disconnect();
        observers.delete(el);
    },
};
