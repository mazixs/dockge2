<template>
    <!-- Марка продукта: одно написание на все экраны - шапку, вход, первый запуск
         и раздел о продукте. Пока она была выписана в каждом из них, имя читалось
         то "dockge2", то "Dockge", и на одном экране номер поколения пропадал -->
    <span class="brand-mark">dockge<span class="generation">2</span></span>
</template>

<script>
export default {
    name: "BrandMark",
};
</script>

<style lang="scss" scoped>
.brand-mark {
    font-weight: var(--weight-strong);
    letter-spacing: var(--tracking-title);
    white-space: nowrap;
}

// Номер поколения мельче имени и всегда акцентом: он часть марки, а не слово
// рядом с ней. Доля от кегля, а не токен шкалы: марка стоит в шапке, на карточке
// входа и в разделе о продукте разного размера, а пропорция у нее одна
.generation {
    margin-left: 3px;
    color: var(--accent-text);
    font-size: 73%;
}
</style>
