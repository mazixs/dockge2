/**
 * Форматирование чисел и длительностей для интерфейса.
 *
 * Живёт отдельным файлом, потому что строка списка и инспектор обязаны говорить
 * одинаково: «94,2%» и «3 дня» не должны в двух местах округляться по-разному.
 */

/**
 * Доля как процент с одним знаком, в записи выбранного языка.
 *
 * Язык передаётся явно, а не берётся системный: иначе одна и та же панель
 * писала бы «94,2%» или «94.2%» в зависимости от машины, на которой открыта.
 * @param ratio Доля от нуля до единицы
 * @param locale Язык интерфейса
 * @returns Например «94,2%», пустая строка если доли нет
 */
export function formatPercent(ratio : number | null | undefined, locale = "en", floor = false) : string {
    if (typeof ratio !== "number") {
        return "";
    }

    // Доступность вниз, а не по правилам округления: 99,96% не имеет права
    // превратиться в «100%», когда простой был
    const percent = floor ? Math.floor(ratio * 1000) / 10 : ratio * 100;

    return `${percent.toLocaleString(locale, { maximumFractionDigits: 1 })}%`;
}

/** Перевод с поддержкой множественного числа, как его даёт vue-i18n */
type Translate = (key : string, count : number) => string;

/**
 * Длительность словами: минуты, часы или сутки - та единица, которую человек
 * назвал бы сам. Точность до секунды здесь не нужна и только мешает читать.
 * @param ms Длительность в миллисекундах
 * @param t Функция перевода
 * @returns Например «6 мин», «3 ч» или «3 дня»
 */
export function formatDuration(ms : number | null | undefined, t : Translate) : string {
    if (typeof ms !== "number" || ms < 0) {
        return "";
    }

    const minutes = Math.floor(ms / 60_000);

    if (minutes < 60) {
        return t("durationMinutes", Math.max(minutes, 1));
    }

    const hours = Math.floor(minutes / 60);

    if (hours < 24) {
        return t("durationHours", hours);
    }

    return t("durationDays", Math.floor(hours / 24));
}
